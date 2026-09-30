import { Injectable, UnauthorizedException, ConflictException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { addDays } from 'date-fns';
import { OtpPurpose, UserRole } from '@prisma/client';
import { OtpService } from './otp.service';
import { normalizeBdPhone } from '../../common/utils/phone.util';
import { GoogleAuthProvider } from './social/google-auth.provider';
import { FacebookAuthProvider } from './social/facebook-auth.provider';
import { SocialIdentity } from './social/social-identity.interface';

/** Prisma's code for a unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly otp: OtpService,
    private readonly google: GoogleAuthProvider,
    private readonly facebook: FacebookAuthProvider,
  ) {}

  async register(registerDto: RegisterDto) {
    const existingUser = await this.prisma.user.findUnique({
      where: { email: registerDto.email },
    });

     if (existingUser) {
       throw new ConflictException('Email already registered');
     }

    const hashedPassword = await argon2.hash(registerDto.password);

    const userRole =
      (await this.prisma.role.findFirst({ where: { name: 'customer' } })) ??
      (await this.prisma.role.findFirst({ where: { name: 'user' } }));

    const user = await this.prisma.user.create({
      data: {
        email: registerDto.email,
        password: hashedPassword,
        name: registerDto.name ?? registerDto.email,
        role: UserRole.CUSTOMER,
        roleId: userRole?.id ?? null,
      },
    });

    const tokens = await this.generateTokens(user.id, user.email);
    await this.saveRefreshToken(user.id, tokens.refreshToken);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        roleId: user.roleId,
      },
      ...tokens,
    };
  }

  async login(loginDto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: loginDto.email },
      include: { rbacRole: true, vendor: true },
    });

    if (!user || user.deletedAt) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await argon2.verify(
      user.password,
      loginDto.password,
    );

    if (!passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const tokens = await this.generateTokens(user.id, user.email);
    await this.saveRefreshToken(user.id, tokens.refreshToken);

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roleId: user.roleId,
      },
      ...tokens,
    };
  }

  async refresh(refreshToken: string) {
    const payload = this.jwtService.verify(refreshToken, {
      secret: this.configService.get<string>('jwt.refreshSecret') as string,
    });

    const storedToken = await this.prisma.refreshToken.findFirst({
      where: {
        userId: payload.sub,
        revoked: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      include: { user: true },
    });

    if (!storedToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokenMatches = await argon2.verify(
      storedToken.tokenHash,
      refreshToken,
    );

    if (!tokenMatches) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: payload.sub },
        data: { revoked: true },
      });
      throw new UnauthorizedException('Token reuse detected');
    }

    await this.prisma.refreshToken.update({
      where: { id: storedToken.id },
      data: { revoked: true },
    });

    const tokens = await this.generateTokens(
      storedToken.user.id,
      storedToken.user.email,
    );
    await this.saveRefreshToken(storedToken.user.id, tokens.refreshToken);

    return {
      user: {
        id: storedToken.user.id,
        email: storedToken.user.email,
        name: storedToken.user.name,
        role: storedToken.user.role,
        roleId: storedToken.user.roleId,
      },
      ...tokens,
    };
  }

  /**
   * Signs in (or registers) a caller through Google.
   *
   * The token is verified before anything is read from or written to the
   * database, so a forged or misdirected token cannot reach the account
   * resolution below.
   */
  async loginWithGoogle(idToken: string) {
    return this.resolveSocialIdentity(await this.google.verify(idToken));
  }

  /** Signs in (or registers) a caller through Facebook. */
  async loginWithFacebook(accessToken: string) {
    return this.resolveSocialIdentity(await this.facebook.verify(accessToken));
  }

  /**
   * Turns a verified provider identity into a session.
   *
   * Three outcomes, in order:
   *   1. the provider identity is already linked — sign that user in;
   *   2. the provider vouches for an email that matches a local account — link
   *      and sign in, so one person does not end up with two accounts;
   *   3. otherwise create a passwordless CUSTOMER and sign in.
   *
   * A soft-deleted local account is refused in cases 1 and 2 rather than
   * resurrected: honouring the link would hand a closed account back to
   * whoever holds the provider identity.
   */
  private async resolveSocialIdentity(identity: SocialIdentity) {
    const linked = await this.prisma.socialAccount.findUnique({
      where: {
        provider_providerUserId: {
          provider: identity.provider,
          providerUserId: identity.providerUserId,
        },
      },
      include: { user: true },
    });

    if (linked) {
      this.assertUsable(linked.user);
      return this.issueSession(linked.user);
    }

    // Only a provider-asserted address may match a local account. Keying on an
    // unverified one would let anyone mint an address at a provider and claim
    // whichever local account happens to hold it.
    const byEmail =
      identity.email && identity.emailVerified
        ? await this.findUserByEmail(identity.email)
        : null;

    if (byEmail) {
      this.assertUsable(byEmail);
      await this.link(identity, byEmail.id);
      return this.issueSession(byEmail);
    }

    const created = await this.createSocialUser(identity);
    return this.issueSession(created);
  }

  /**
   * Matches on email case-insensitively.
   *
   * Nothing in the codebase lowercases addresses, and Postgres unique indexes
   * are case-sensitive, so an exact match would treat `A@B.com` and `a@b.com`
   * as two people — a provider returning a different casing than the address
   * was registered with would then mint a duplicate account.
   */
  private findUserByEmail(email: string) {
    return this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
  }

  private assertUsable(user: { id: string; deletedAt: Date | null }): void {
    if (user.deletedAt) {
      throw new UnauthorizedException('This account is no longer available');
    }
  }

  /**
   * Records the link, tolerating a concurrent first sign-in.
   *
   * Two requests for the same new identity can both reach this point before
   * either commits. The unique index on [provider, providerUserId] is what
   * actually decides the winner; the loser re-reads and adopts that link rather
   * than surfacing a constraint error to someone who did nothing wrong.
   */
  private async link(identity: SocialIdentity, userId: string) {
    try {
      await this.prisma.socialAccount.create({
        data: {
          userId,
          provider: identity.provider,
          providerUserId: identity.providerUserId,
          email: identity.email,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      const winner = await this.prisma.socialAccount.findUnique({
        where: {
          provider_providerUserId: {
            provider: identity.provider,
            providerUserId: identity.providerUserId,
          },
        },
      });

      if (!winner || winner.userId !== userId) {
        // Someone else holds this provider identity and is not the account we
        // matched by email. Linking anyway would merge two people's accounts.
        throw new ConflictException(
          'This social account is already linked to a different user',
        );
      }
    }
  }

  /**
   * Creates a local account for a provider identity that matched nothing.
   *
   * `password` is non-nullable in the schema, so a hash of fresh random bytes
   * stands in for it. The alternative — a hash of a known constant — would let
   * anyone who guessed it sign in with a password, defeating the point of the
   * account having none.
   */
  private async createSocialUser(identity: SocialIdentity) {
    const userRole =
      (await this.prisma.role.findFirst({ where: { name: 'customer' } })) ??
      (await this.prisma.role.findFirst({ where: { name: 'user' } }));

    try {
      const user = await this.prisma.user.create({
        data: {
          // Null rather than a placeholder when the provider withholds the
          // address: a fabricated one would occupy the unique email column and
          // could collide with a real signup.
          email: identity.emailVerified ? identity.email : null,
          password: await argon2.hash(randomBytes(32).toString('hex')),
          name: identity.name ?? identity.email ?? `${identity.provider} user`,
          role: UserRole.CUSTOMER,
          roleId: userRole?.id ?? null,
          // The provider already proved control of this identity, which is what
          // this flag means everywhere else in the app.
          isVerified: true,
        },
      });

      await this.link(identity, user.id);

      return user;
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A concurrent request created the account, or claimed this email, first.
        const existing = identity.email
          ? await this.findUserByEmail(identity.email)
          : null;

        if (existing && !existing.deletedAt) {
          await this.link(identity, existing.id);
          return existing;
        }
      }

      throw error;
    }
  }

  async logout(userId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true },
    });
    return { message: 'Logged out successfully' };
  }

  async generateTokens(userId: string, email: string | null) {
    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(
        { sub: userId, email },
        {
          secret: this.configService.get<string>('jwt.accessSecret') as string,
          expiresIn: this.configService.get<string>('jwt.accessExpiresIn') as any,
        } as any,
      ),
      this.jwtService.signAsync(
        { sub: userId },
        {
          secret: this.configService.get<string>('jwt.refreshSecret') as string,
          expiresIn: this.configService.get<string>('jwt.refreshExpiresIn') as any,
        } as any,
      ),
    ]);

    return {
      accessToken,
      refreshToken,
      accessExpiresIn: this.configService.get<string>('jwt.accessExpiresIn') as string,
    };
  }

  async saveRefreshToken(userId: string, token: string) {
    const tokenHash = await argon2.hash(token);
    const expiresAt = addDays(new Date(), 7);

    await this.prisma.refreshToken.create({
      data: {
        tokenHash,
        userId,
        expiresAt,
      },
    });
  }

  async validateUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { rbacRole: true },
    });
    if (!user || user.deletedAt) {
      throw new UnauthorizedException('User not found');
    }
    return user;
  }

  /**
   * Public entry point for `POST /auth/otp/request`.
   *
   * Normalisation happens here, before anything touches the database, so every
   * downstream layer can assume `+8801…`. An unusable number is rejected as a
   * 400 — that leaks nothing, since it is a malformed input rather than a
   * statement about which numbers exist.
   */
  async requestOtp(phone: string, purpose: OtpPurpose) {
    const normalized = this.normalizeOrReject(phone);
    return this.otp.request(normalized, purpose);
  }

  /**
   * Public entry point for `POST /auth/otp/verify`.
   *
   * LOGIN and REGISTER mint a session; RESET_PASSWORD and VERIFY_PHONE are
   * handled by their own endpoints, so a code for one purpose can never be
   * spent on another route.
   */
  async verifyOtp(phone: string, code: string, purpose: OtpPurpose) {
    const normalized = this.normalizeOrReject(phone);

    if (purpose === OtpPurpose.LOGIN) {
      return this.loginWithOtp(normalized, code);
    }

    if (purpose === OtpPurpose.REGISTER) {
      return this.registerWithOtp(normalized, code);
    }

    throw new BadRequestException(
      `A ${purpose} code cannot be verified here; use the matching endpoint`,
    );
  }

  private normalizeOrReject(phone: string): string {
    try {
      return normalizeBdPhone(phone);
    } catch {
      // BadRequestException, not the util's own error type, so the global filter
      // renders a 400 with the usual shape.
      throw new BadRequestException('Enter a valid Bangladeshi phone number');
    }
  }

  /**
   * OTP login. A valid code for a phone that has no user is rejected here rather
   * than at request time, so the response to `/auth/otp/request` never reveals
   * whether a number is registered.
   */
  async loginWithOtp(phone: string, code: string) {
    await this.otp.verify(phone, code, OtpPurpose.LOGIN);

    const user = await this.prisma.user.findUnique({
      where: { phone },
      include: { rbacRole: true, vendor: true },
    });

    if (!user || user.deletedAt) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return this.issueSession(user);
  }

  /**
   * OTP registration. An existing user for the number is signed in as-is rather
   * than rejected, so the same SMS flow works whether or not the account is new
   * — a mismatch here would leak account existence.
   */
  async registerWithOtp(phone: string, code: string) {
    await this.otp.verify(phone, code, OtpPurpose.REGISTER);

    const existing = await this.prisma.user.findUnique({
      where: { phone },
      include: { rbacRole: true, vendor: true },
    });

    if (existing && !existing.deletedAt) {
      return this.issueSession(existing);
    }

    const userRole =
      (await this.prisma.role.findFirst({ where: { name: 'customer' } })) ??
      (await this.prisma.role.findFirst({ where: { name: 'user' } }));

    const created = await this.prisma.user.create({
      data: {
        phone,
        // No password is set: the phone OTP is the credential. `password` is
        // non-nullable in the schema, so an unusable random hash stands in for
        // it — an empty string would be a password anyone could "guess".
        password: await argon2.hash(randomBytes(32).toString('hex')),
        name: phone,
        role: UserRole.CUSTOMER,
        roleId: userRole?.id ?? null,
        isVerified: true,
      },
      include: { rbacRole: true, vendor: true },
    });

    return this.issueSession(created);
  }

  /**
   * Confirms the authenticated user's own phone.
   *
   * The number is read from the user's own record rather than taken from the
   * request, so this route cannot be used to verify somebody else's phone. The
   * JWT carries no phone claim, so trusting `req.user.phone` would silently
   * verify against `undefined`.
   */
  async verifyPhone(userId: string, code: string, purpose: OtpPurpose) {
    const user = await this.validateUser(userId);

    if (!user.phone) {
      throw new BadRequestException('No phone number on this account');
    }

    await this.otp.verify(user.phone, code, purpose);

    return this.prisma.user.update({
      where: { id: userId },
      data: { isVerified: true },
      select: { id: true, phone: true, isVerified: true },
    });
  }

  /**
   * Resets a password with a RESET_PASSWORD code, then revokes every refresh
   * token for the user.
   *
   * Revocation is the point of the flow: if the reset follows a compromise, the
   * attacker's long-lived refresh token has to die with it, or the reset is
   * cosmetic.
   */
  async resetPassword(phone: string, code: string, newPassword: string) {
    await this.otp.verify(phone, code, OtpPurpose.RESET_PASSWORD);

    const user = await this.prisma.user.findUnique({ where: { phone } });

    if (!user || user.deletedAt) {
      throw new BadRequestException('Invalid or expired code');
    }

    const hashedPassword = await argon2.hash(newPassword);

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.user.update({
        where: { id: user.id },
        data: { password: hashedPassword },
        select: { id: true, phone: true, email: true, isVerified: true },
      });

      await tx.refreshToken.updateMany({
        where: { userId: user.id, revoked: false },
        data: { revoked: true },
      });

      return result;
    });

    return { ...updated, message: 'Password reset successfully' };
  }

  /** Shared tail of every OTP sign-in: mint tokens and persist the refresh token. */
  private async issueSession(user: {
    id: string;
    email: string | null;
    phone?: string | null;
    name: string;
    role: UserRole;
    roleId: string | null;
  }) {
    const tokens = await this.generateTokens(user.id, user.email);
    await this.saveRefreshToken(user.id, tokens.refreshToken);

    return {
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone ?? null,
        name: user.name,
        role: user.role,
        roleId: user.roleId,
      },
      ...tokens,
    };
  }
}