import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import * as argon2 from 'argon2';
import { SocialProvider, UserRole } from '@prisma/client';
import { AuthService } from '../src/modules/auth/auth.service';
import { PrismaService } from '../src/database/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { OtpService } from '../src/modules/auth/otp.service';
import { GoogleAuthProvider } from '../src/modules/auth/social/google-auth.provider';
import { FacebookAuthProvider } from '../src/modules/auth/social/facebook-auth.provider';
import { SocialIdentity } from '../src/modules/auth/social/social-identity.interface';
import { FacebookAuthDto, GoogleAuthDto } from '../src/modules/auth/dto/social-auth.dto';

const uniqueViolation = Object.assign(new Error('unique'), { code: 'P2002' });

const user = (overrides: Record<string, unknown> = {}) => ({
  id: 'u1',
  email: 'buyer@example.com',
  phone: null,
  password: 'argon2-hash',
  name: 'Buyer',
  role: UserRole.CUSTOMER,
  roleId: 'r1',
  isVerified: true,
  deletedAt: null,
  ...overrides,
});

const identity = (overrides: Partial<SocialIdentity> = {}): SocialIdentity => ({
  provider: SocialProvider.GOOGLE,
  providerUserId: 'g-123',
  email: 'buyer@example.com',
  emailVerified: true,
  name: 'Buyer',
  ...overrides,
});

function build() {
  const prisma: any = {
    socialAccount: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
    user: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
    role: { findFirst: vi.fn().mockResolvedValue({ id: 'r1' }) },
    refreshToken: { create: vi.fn(), updateMany: vi.fn() },
  };

  const jwt = {
    signAsync: vi.fn(async (payload: object) => `token:${JSON.stringify(payload)}`),
  };

  const config = {
    get: vi.fn((key: string) =>
      ({
        'jwt.accessSecret': 'a'.repeat(40),
        'jwt.refreshSecret': 'b'.repeat(40),
        'jwt.accessExpiresIn': '15m',
        'jwt.refreshExpiresIn': '7d',
      })[key],
    ),
  };

  const google = { verify: vi.fn() } as unknown as GoogleAuthProvider;
  const facebook = { verify: vi.fn() } as unknown as FacebookAuthProvider;

  const service = new AuthService(
    prisma as unknown as PrismaService,
    jwt as unknown as JwtService,
    config as unknown as ConfigService,
    {} as OtpService,
    google,
    facebook,
  );

  return { service, prisma, google, facebook, jwt };
}

describe('Social sign-in — returning user (linking)', () => {
  it('signs in the linked user without creating anything', async () => {
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity());
    prisma.socialAccount.findUnique.mockResolvedValue({ user: user() });

    const result = await service.loginWithGoogle('tok');

    expect(result.user.id).toBe('u1');
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.socialAccount.create).not.toHaveBeenCalled();
  });

  it('looks the account up by provider and subject id, never by email', async () => {
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity());
    prisma.socialAccount.findUnique.mockResolvedValue({ user: user() });

    await service.loginWithGoogle('tok');

    expect(prisma.socialAccount.findUnique).toHaveBeenCalledWith({
      where: {
        provider_providerUserId: {
          provider: SocialProvider.GOOGLE,
          providerUserId: 'g-123',
        },
      },
      include: { user: true },
    });
  });

  it('resolves the same identity to the same account on a second sign-in', async () => {
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity());
    prisma.socialAccount.findUnique.mockResolvedValue({ user: user() });

    await service.loginWithGoogle('tok');
    await service.loginWithGoogle('tok');

    expect(prisma.user.create).toHaveBeenCalledTimes(0);
    expect(prisma.socialAccount.create).toHaveBeenCalledTimes(0);
  });

  it('refuses a soft-deleted account rather than resurrecting it', async () => {
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity());
    prisma.socialAccount.findUnique.mockResolvedValue({
      user: user({ deletedAt: new Date() }),
    });

    await expect(service.loginWithGoogle('tok')).rejects.toThrow(
      /no longer available/,
    );
  });
});

describe('Social sign-in — new user creation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a CUSTOMER when nothing matches', async () => {
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity());
    prisma.user.create.mockResolvedValue(user({ id: 'u-new' }));

    const result = await service.loginWithGoogle('tok');

    expect(result.user.id).toBe('u-new');
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    expect(prisma.user.create.mock.calls[0][0].data).toMatchObject({
      email: 'buyer@example.com',
      role: UserRole.CUSTOMER,
      roleId: 'r1',
      isVerified: true,
      name: 'Buyer',
    });
  });

  it('stores a password that no guess can satisfy', async () => {
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity());
    prisma.user.create.mockResolvedValue(user({ id: 'u-new' }));

    await service.loginWithGoogle('tok');

    const { password } = prisma.user.create.mock.calls[0][0].data;

    // A real Argon2 hash, so `argon2.verify` in the password login path does
    // not throw on a malformed value.
    expect(password).toMatch(/^\$argon2/);
    // and it is not the hash of anything an attacker would try.
    for (const guess of ['', 'password', 'Password123!', 'null', 'undefined', 'buyer@example.com']) {
      expect(await argon2.verify(password, guess)).toBe(false);
    }
  });

  it('links the new account to the provider identity', async () => {
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity());
    prisma.user.create.mockResolvedValue(user({ id: 'u-new' }));

    await service.loginWithGoogle('tok');

    expect(prisma.socialAccount.create).toHaveBeenCalledWith({
      data: {
        userId: 'u-new',
        provider: SocialProvider.GOOGLE,
        providerUserId: 'g-123',
        email: 'buyer@example.com',
      },
    });
  });

  it('persists a refresh token like a normal login', async () => {
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity());
    prisma.user.create.mockResolvedValue(user({ id: 'u-new' }));

    const result = await service.loginWithGoogle('tok');

    expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
    expect(result.accessExpiresIn).toBe('15m');
  });

  it('falls back through customer to user for the RBAC role', async () => {
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity());
    prisma.role.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'r-user' });
    prisma.user.create.mockResolvedValue(user({ id: 'u-new' }));

    await service.loginWithGoogle('tok');

    expect(prisma.user.create.mock.calls[0][0].data.roleId).toBe('r-user');
  });

  it('leaves roleId null when no role row matches', async () => {
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity());
    prisma.role.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue(user({ id: 'u-new' }));

    await service.loginWithGoogle('tok');

    expect(prisma.user.create.mock.calls[0][0].data.roleId).toBeNull();
  });

  it('falls back to the email for a name when the provider sends none', async () => {
    // Same convention as the password register flow, which uses the address as
    // the display name.
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity({ name: null }));
    prisma.user.create.mockResolvedValue(user({ id: 'u-new' }));

    await service.loginWithGoogle('tok');

    expect(prisma.user.create.mock.calls[0][0].data.name).toBe('buyer@example.com');
  });

  it('falls back to a provider label when there is neither name nor email', async () => {
    const { service, prisma, facebook } = build();
    facebook.verify = vi.fn().mockResolvedValue(
      identity({
        provider: SocialProvider.FACEBOOK,
        name: null,
        email: null,
        emailVerified: false,
      }),
    );
    prisma.user.create.mockResolvedValue(user({ id: 'u-new', email: null }));

    await service.loginWithFacebook('tok');

    expect(prisma.user.create.mock.calls[0][0].data.name).toBe('FACEBOOK user');
  });

  it('creates a user with no email when the provider withholds one', async () => {
    // Facebook users who never added an address are real. Inventing a
    // placeholder would occupy the unique email column and could collide with a
    // genuine signup.
    const { service, prisma, facebook } = build();
    facebook.verify = vi.fn().mockResolvedValue(
      identity({ provider: SocialProvider.FACEBOOK, email: null, emailVerified: false }),
    );
    prisma.user.create.mockResolvedValue(user({ id: 'u-new', email: null }));

    const result = await service.loginWithFacebook('tok');

    expect(prisma.user.create.mock.calls[0][0].data.email).toBeNull();
    expect(result.user.id).toBe('u-new');
  });
});

describe('Social sign-in — linking to an existing account by email', () => {
  it('links rather than creating a second account', async () => {
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity());
    prisma.user.findFirst.mockResolvedValue(user());

    const result = await service.loginWithGoogle('tok');

    expect(result.user.id).toBe('u1');
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.socialAccount.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        provider: SocialProvider.GOOGLE,
        providerUserId: 'g-123',
        email: 'buyer@example.com',
      },
    });
  });

  it('matches the email case-insensitively', async () => {
    // Nothing lowercases addresses anywhere in this codebase, so an exact match
    // would treat a differently-cased provider email as a different person.
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity({ email: 'Buyer@Example.com' }));
    prisma.user.findFirst.mockResolvedValue(user());

    await service.loginWithGoogle('tok');

    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { email: { equals: 'Buyer@Example.com', mode: 'insensitive' } },
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('refuses to link to a soft-deleted account', async () => {
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity());
    prisma.user.findFirst.mockResolvedValue(user({ deletedAt: new Date() }));

    await expect(service.loginWithGoogle('tok')).rejects.toThrow(/no longer available/);
    expect(prisma.socialAccount.create).not.toHaveBeenCalled();
  });
});

describe('Social sign-in — unverified email is never trusted', () => {
  it('does not match an existing account by an unverified email', async () => {
    // The attack this blocks: mint a Google account on an address you do not
    // own, unverified, and present it to claim the local account that holds it.
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(
      identity({ email: 'victim@example.com', emailVerified: false }),
    );
    prisma.user.create.mockResolvedValue(user({ id: 'u-new' }));

    await service.loginWithGoogle('tok');

    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    expect(prisma.user.create.mock.calls[0][0].data.email).toBeNull();
  });

  it('propagates the provider rejection for an unverified Google email', async () => {
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockRejectedValue(
      Object.assign(new Error('Google account email is not verified'), { status: 401 }),
    );

    await expect(service.loginWithGoogle('tok')).rejects.toThrow(/not verified/);
    // Nothing may be read or written on an unverified identity.
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.socialAccount.create).not.toHaveBeenCalled();
  });
});

describe('Social sign-in — concurrent first sign-in', () => {
  it('adopts the link a concurrent request already won', async () => {
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity());
    prisma.user.findFirst.mockResolvedValue(user());
    prisma.socialAccount.create.mockRejectedValue(uniqueViolation);
    prisma.socialAccount.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ userId: 'u1' });

    const result = await service.loginWithGoogle('tok');

    expect(result.user.id).toBe('u1');
  });

  it('refuses to merge two accounts when the winner is somebody else', async () => {
    // Both requests matched a different local user by email; the unique index
    // stops the second link, and it must not be forced through.
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity());
    prisma.user.findFirst.mockResolvedValue(user());
    prisma.socialAccount.create.mockRejectedValue(uniqueViolation);
    prisma.socialAccount.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ userId: 'u-someone-else' });

    await expect(service.loginWithGoogle('tok')).rejects.toThrow(
      /already linked to a different user/,
    );
  });

  it('adopts an account a concurrent request created for the same email', async () => {
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity());
    prisma.user.create.mockRejectedValue(uniqueViolation);
    prisma.user.findFirst.mockResolvedValue(user({ id: 'u-winner' }));

    const result = await service.loginWithGoogle('tok');

    expect(result.user.id).toBe('u-winner');
    expect(prisma.socialAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: 'u-winner' }) }),
    );
  });

  it('rethrows a unique violation it cannot resolve', async () => {
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity({ email: null }));
    prisma.user.create.mockRejectedValue(uniqueViolation);

    await expect(service.loginWithGoogle('tok')).rejects.toThrow('unique');
  });

  it('rethrows a non-unique database error', async () => {
    const { service, prisma, google } = build();
    google.verify = vi.fn().mockResolvedValue(identity());
    prisma.user.findFirst.mockResolvedValue(user());
    prisma.socialAccount.create.mockRejectedValue(new Error('connection lost'));

    await expect(service.loginWithGoogle('tok')).rejects.toThrow('connection lost');
  });
});

describe('Social sign-in request bodies', () => {
  // The global pipe runs with `forbidNonWhitelisted`, so an unrecognised field
  // is a 422 rather than being silently dropped. That matters more than usual
  // here: a client sending `accessToken` to the Google route should be told, not
  // have it ignored and then fail on a missing `idToken`.
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    errorHttpStatusCode: 422,
  });

  const validate = (cls: new () => object, body: Record<string, unknown>) =>
    pipe.transform(body, { type: 'body' as const, metatype: cls });

  it('accepts a Google ID token', async () => {
    await expect(validate(GoogleAuthDto, { idToken: 'tok' })).resolves.toBeDefined();
  });

  it('accepts a Facebook access token', async () => {
    await expect(validate(FacebookAuthDto, { accessToken: 'tok' })).resolves.toBeDefined();
  });

  it('rejects an empty Google token', async () => {
    await expect(validate(GoogleAuthDto, { idToken: '' })).rejects.toThrow();
    await expect(validate(GoogleAuthDto, {})).rejects.toThrow();
  });

  it('rejects an empty Facebook token', async () => {
    await expect(validate(FacebookAuthDto, { accessToken: '' })).rejects.toThrow();
    await expect(validate(FacebookAuthDto, {})).rejects.toThrow();
  });

  it('rejects a non-string token', async () => {
    await expect(validate(GoogleAuthDto, { idToken: 12345 })).rejects.toThrow();
    await expect(validate(FacebookAuthDto, { accessToken: { a: 1 } })).rejects.toThrow();
  });

  it('rejects an absurdly long token', async () => {
    await expect(
      validate(GoogleAuthDto, { idToken: 'x'.repeat(5000) }),
    ).rejects.toThrow();
  });

  it('rejects a Facebook token sent to the Google route', async () => {
    await expect(validate(GoogleAuthDto, { accessToken: 'tok' })).rejects.toThrow();
  });

  it('rejects unknown fields', async () => {
    await expect(
      validate(FacebookAuthDto, { accessToken: 'tok', isAdmin: true }),
    ).rejects.toThrow();
  });
});
