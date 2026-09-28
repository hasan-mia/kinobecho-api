import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Restricts a route to the given business roles (User.role). Composes with
 * @RequirePermissions() — the RolesGuard only runs when roles are declared.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
