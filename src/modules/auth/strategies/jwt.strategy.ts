import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';

export interface JwtPayload {
  sub: string;
  email: string | null;
  roleId?: string | null;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private prisma: PrismaService,
    configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('jwt.accessSecret') as string,
    } as any);
  }

  override async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: { rbacRole: true, vendor: true },
    });

    if (!user || user.deletedAt) {
      throw new UnauthorizedException('Invalid token');
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      roleId: user.roleId,
      role: user.role,
      vendor: user.vendor
        ? {
            id: user.vendor.id,
            slug: user.vendor.slug,
            businessName: user.vendor.businessName,
            status: user.vendor.status,
          }
        : null,
    };
  }
}