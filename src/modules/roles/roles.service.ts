import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { AssignPermissionsDto } from './dto/assign-permissions.dto';
import { RoleAuditLog } from '@prisma/client';
import { PERMISSION_KEYS, SYSTEM_PERMISSIONS } from './permissions.registry';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheManager: RedisCacheService,
  ) {}

  async findAll() {
    return this.prisma.role.findMany({
      include: {
        permissions: {
          include: { permission: true },
        },
        _count: {
          select: { users: true },
        },
      },
    });
  }

  async findOne(id: string) {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: {
        permissions: {
          include: { permission: true },
        },
      },
    });

    if (!role) {
      throw new NotFoundException('Role not found');
    }

    return role;
  }

  async create(createDto: CreateRoleDto) {
    const existingRole = await this.prisma.role.findUnique({
      where: { name: createDto.name },
    });

    if (existingRole) {
      throw new ConflictException('Role already exists');
    }

    const role = await this.prisma.role.create({
      data: {
        name: createDto.name,
        description: createDto.description,
      },
    });

    if (createDto.permissions && createDto.permissions.length > 0) {
      await this.assignPermissions(role.id, {
        permissions: createDto.permissions,
      });
    }

    return role;
  }

  async update(id: string, updateDto: UpdateRoleDto) {
    const role = await this.prisma.role.findUnique({
      where: { id },
    });

    if (!role) {
      throw new NotFoundException('Role not found');
    }

    if (role.isSystem && updateDto.name !== undefined) {
      throw new BadRequestException('Cannot rename system role');
    }

    if (role.isSystem && updateDto.description !== undefined) {
      throw new BadRequestException('Cannot modify system role');
    }

    return this.prisma.role.update({
      where: { id },
      data: {
        name: updateDto.name,
        description: updateDto.description,
      },
    });
  }

  async remove(id: string) {
    const role = await this.prisma.role.findUnique({
      where: { id },
      include: {
        _count: {
          select: { users: true },
        },
      },
    });

    if (!role) {
      throw new NotFoundException('Role not found');
    }

    if (role.isSystem) {
      throw new BadRequestException('Cannot delete system role');
    }

    if (role._count.users > 0) {
      throw new BadRequestException('Cannot delete role with assigned users');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await tx.role.delete({ where: { id } });
    });

    return { message: 'Role deleted successfully' };
  }

  async assignPermissions(id: string, assignDto: AssignPermissionsDto) {
    const role = await this.prisma.role.findUnique({
      where: { id },
    });

    if (!role) {
      throw new NotFoundException('Role not found');
    }

    const validatedPermissions = assignDto.permissions.filter((p) =>
      PERMISSION_KEYS.includes(p as any),
    );

    if (validatedPermissions.length !== assignDto.permissions.length) {
      throw new BadRequestException('Invalid permission(s) provided');
    }

    if (role.isSystem) {
      const hasSystemPermission = validatedPermissions.some((p) =>
        SYSTEM_PERMISSIONS.includes(p as any),
      );
      if (!hasSystemPermission) {
        throw new BadRequestException(
          'System roles must retain their system permissions',
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      if (validatedPermissions.length > 0) {
        await tx.rolePermission.createMany({
          data: validatedPermissions.map((permission) => ({
            roleId: id,
            permissionId: '',
          })),
        });
      }
    });

    await this.invalidatePermissionCache(id);

    return this.prisma.role.findUnique({
      where: { id },
      include: { permissions: { include: { permission: true } } },
    });
  }

  async invalidatePermissionCache(roleId: string) {
    const cacheKey = `role_permissions:${roleId}`;
    await this.cacheManager.del(cacheKey);
  }

  async createAuditLog(
    actorId: string,
    action: string,
    targetRoleId: string,
    diff?: string,
  ) {
    await this.prisma.roleAuditLog.create({
      data: {
        actorId,
        action,
        targetRoleId,
        diff,
      },
    });
  }
}
