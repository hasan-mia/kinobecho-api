import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class WsJwtGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient();
    const token = client.handshake.auth?.token;

    if (!token) {
      throw new UnauthorizedException('Authentication token required');
    }

    try {
      const secret = this.configService.get<string>('jwt.accessSecret') as string;
      const payload = this.jwtService.verify(token, { secret });

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        include: { rbacRole: true, vendor: true },
      });

      if (!user || user.deletedAt) {
        throw new UnauthorizedException('Invalid token');
      }

      client.data.user = {
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

      return true;
    } catch (err) {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}