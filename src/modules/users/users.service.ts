import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole, VendorStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { USER_ROLE_PERMISSIONS } from '../roles/permissions.registry';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.user.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        roleId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        roleId: true,
        rbacRole: {
          select: {
            id: true,
            name: true,
            description: true,
            isSystem: true,
          },
        },
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  /**
   * Profile for GET /users/me. Alongside the identity fields it resolves the
   * effective permission keys so the SPA can hide UI it is not allowed to use
   * without duplicating the RBAC lookup. Permissions come from the user's
   * dynamic RBAC role; when no role (or a role with no permissions yet) is
   * assigned, the static USER_ROLE_PERMISSIONS set is the fallback.
   */
  async getProfile(id: string) {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        email: true,
        phone: true,
        name: true,
        avatarUrl: true,
        isVerified: true,
        role: true,
        roleId: true,
        vendor: { select: { id: true, status: true } },
        rbacRole: {
          select: {
            id: true,
            name: true,
            permissions: { select: { permission: { select: { key: true } } } },
          },
        },
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const rbacPermissions = user.rbacRole?.permissions.map(
      (rp) => rp.permission.key,
    );

    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      name: user.name,
      avatarUrl: user.avatarUrl,
      isVerified: user.isVerified,
      role: user.role,
      roleId: user.roleId,
      roleName: user.rbacRole?.name ?? null,
      vendorId: user.vendor?.id ?? null,
      vendorStatus: user.vendor?.status ?? null,
      permissions:
        rbacPermissions && rbacPermissions.length > 0
          ? rbacPermissions
          : [...USER_ROLE_PERMISSIONS],
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  async assignRole(userId: string, roleId: string) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { roleId },
      include: { rbacRole: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
  }

  /**
   * Soft delete. A hard delete is impossible because Order.buyerId / Order.vendorId
   * use ON DELETE RESTRICT — orders must never be orphaned. Instead the row is
   * kept, marked with deletedAt, all refresh tokens are revoked and the vendor
   * profile (if any) is suspended.
   */
  async remove(id: string, caller: AuthenticatedUser) {
    if (caller.id === id) {
      throw new ForbiddenException('You cannot delete your own account');
    }

    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { vendor: { select: { id: true } } },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role === UserRole.SUPER_ADMIN && caller.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException(
        'Only a SUPER_ADMIN can delete another SUPER_ADMIN',
      );
    }

    const deletedAt = new Date();

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id },
        data: { deletedAt },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId: id, revoked: false },
        data: { revoked: true },
      }),
      ...(user.vendor
        ? [
            this.prisma.vendor.update({
              where: { id: user.vendor.id },
              data: { status: VendorStatus.SUSPENDED },
            }),
          ]
        : []),
    ]);

    return { message: 'User deleted successfully' };
  }

  async listAddresses(userId: string) {
    return this.prisma.address.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async createAddress(userId: string, dto: CreateAddressDto) {
    if (dto.isDefault) {
      await this.prisma.address.updateMany({
        where: { userId },
        data: { isDefault: false },
      });
    }

    return this.prisma.address.create({
      data: {
        userId,
        label: dto.label,
        recipientName: dto.recipientName,
        phone: dto.phone,
        line1: dto.line1,
        line2: dto.line2,
        city: dto.city,
        district: dto.district,
        postalCode: dto.postalCode,
        country: dto.country ?? 'BD',
        isDefault: dto.isDefault ?? false,
      },
    });
  }

  async updateAddress(userId: string, id: string, dto: UpdateAddressDto) {
    const address = await this.prisma.address.findFirst({
      where: { id, userId },
    });

    if (!address) {
      throw new NotFoundException('Address not found');
    }

    if (dto.isDefault) {
      await this.prisma.address.updateMany({
        where: { userId },
        data: { isDefault: false },
      });
    }

    return this.prisma.address.update({
      where: { id: address.id },
      data: dto,
    });
  }

  async removeAddress(userId: string, id: string) {
    const address = await this.prisma.address.findFirst({
      where: { id, userId },
    });

    if (!address) {
      throw new NotFoundException('Address not found');
    }

    await this.prisma.address.delete({ where: { id: address.id } });

    return { message: 'Address deleted' };
  }
}