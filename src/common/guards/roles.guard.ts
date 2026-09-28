import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole, VendorStatus } from '@prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { Public } from '../decorators/public.decorator';

export interface AuthenticatedUserVendor {
  id: string;
  slug: string;
  businessName: string;
  status: VendorStatus;
}

export interface AuthenticatedUser {
  id: string;
  email: string | null;
  name: string;
  role: UserRole;
  roleId: string | null;
  vendor?: AuthenticatedUserVendor | null;
}

/**
 * Role-based counterpart of PermissionsGuard. Only runs on handlers decorated
 * with @Roles(); ADMIN/SUPER_ADMIN implicitly pass every role check.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    if (context.getType() !== 'http') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as AuthenticatedUser | undefined;

    if (!user?.role) {
      throw new ForbiddenException('Insufficient role');
    }

    if (
      user.role === UserRole.SUPER_ADMIN ||
      user.role === UserRole.ADMIN ||
      requiredRoles.includes(user.role)
    ) {
      return true;
    }

    throw new ForbiddenException(
      `Insufficient role. Required: ${requiredRoles.join(', ')}`,
    );
  }
}
