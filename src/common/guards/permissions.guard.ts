import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisCacheService } from '../cache/redis-cache.service';
import { PrismaService } from '../../database/prisma.service';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private cacheManager: RedisCacheService,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user?.roleId) {
      throw new ForbiddenException('Insufficient permissions');
    }

    const permissionKey = `role_permissions:${user.roleId}`;
    let rolePermissions = await this.cacheManager.get<string[]>(
      permissionKey,
    );

    if (!rolePermissions) {
      const roleWithPermissions = await this.prisma.role.findUnique({
        where: { id: user.roleId },
        include: {
          permissions: {
            include: { permission: true },
          },
        },
      });

      if (!roleWithPermissions) {
        throw new ForbiddenException('Role not found');
      }

      rolePermissions = roleWithPermissions.permissions.map(
        (rp) => rp.permission.key,
      );

      await this.cacheManager.set(permissionKey, rolePermissions, 300);
    }

    const hasPermission = requiredPermissions.every((permission) =>
      rolePermissions.includes(permission),
    );

    if (!hasPermission) {
      throw new ForbiddenException(
        `Insufficient permissions. Required: ${requiredPermissions.join(', ')}`,
      );
    }

    return true;
  }
}