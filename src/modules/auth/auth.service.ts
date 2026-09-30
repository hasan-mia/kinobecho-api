import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { PrismaService } from '../../database/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { addDays } from 'date-fns';
import { UserRole } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
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
}