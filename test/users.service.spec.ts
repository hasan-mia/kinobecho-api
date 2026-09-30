import { describe, expect, it, vi, beforeEach } from 'vitest';
import { UserRole, VendorStatus } from '@prisma/client';
import { UsersService } from '../src/modules/users/users.service';
import { PrismaService } from '../src/database/prisma.service';
import { AuthenticatedUser } from '../src/common/guards/roles.guard';
import { USER_ROLE_PERMISSIONS } from '../src/modules/roles/permissions.registry';

/**
 * Unit tests for UsersService soft delete.
 * PrismaService is mocked; no database is involved.
 */
describe('UsersService.remove (soft delete)', () => {
  let prisma: {
    user: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    refreshToken: { updateMany: ReturnType<typeof vi.fn> };
    vendor: { update: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let service: UsersService;

  const caller = (
    overrides: Partial<AuthenticatedUser> = {},
  ): AuthenticatedUser => ({
    id: 'admin-1',
    email: 'admin@kinobecho.dev',
    name: 'Admin',
    role: UserRole.ADMIN,
    roleId: null,
    vendor: null,
    ...overrides,
  });

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      refreshToken: { updateMany: vi.fn() },
      vendor: { update: vi.fn() },
      $transaction: vi.fn().mockResolvedValue([]),
    };

    service = new UsersService(prisma as unknown as PrismaService);
  });

  it('sets deletedAt instead of hard deleting the user', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      role: UserRole.CUSTOMER,
      vendor: null,
    });

    const before = Date.now();
    await service.remove('user-1', caller());

    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledTimes(1);

    const args = prisma.user.update.mock.calls[0]![0];
    expect(args.where).toEqual({ id: 'user-1' });
    expect(args.data.deletedAt).toBeInstanceOf(Date);
    expect(args.data.deletedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('revokes every active refresh token for the user', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      role: UserRole.CUSTOMER,
      vendor: null,
    });

    await service.remove('user-1', caller());

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', revoked: false },
      data: { revoked: true },
    });
  });

  it('suspends the vendor profile when one exists', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      role: UserRole.VENDOR,
      vendor: { id: 'vendor-1' },
    });

    await service.remove('user-1', caller());

    expect(prisma.vendor.update).toHaveBeenCalledWith({
      where: { id: 'vendor-1' },
      data: { status: VendorStatus.SUSPENDED },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0]![0]).toHaveLength(3);
  });

  it('skips the vendor update when the user has no vendor row', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      role: UserRole.CUSTOMER,
      vendor: null,
    });

    await service.remove('user-1', caller());

    expect(prisma.vendor.update).not.toHaveBeenCalled();
    expect(prisma.$transaction.mock.calls[0]![0]).toHaveLength(2);
  });

  it('refuses to let a user delete themselves', async () => {
    await expect(
      service.remove('admin-1', caller({ id: 'admin-1' })),
    ).rejects.toThrow('You cannot delete your own account');

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses a non-SUPER_ADMIN caller deleting a SUPER_ADMIN', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'root-1',
      role: UserRole.SUPER_ADMIN,
      vendor: null,
    });

    await expect(
      service.remove('root-1', caller({ role: UserRole.ADMIN })),
    ).rejects.toThrow('Only a SUPER_ADMIN can delete another SUPER_ADMIN');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('allows a SUPER_ADMIN caller to delete another SUPER_ADMIN', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'root-1',
      role: UserRole.SUPER_ADMIN,
      vendor: null,
    });

    const result = await service.remove(
      'root-1',
      caller({ id: 'root-2', role: UserRole.SUPER_ADMIN }),
    );

    expect(result).toEqual({ message: 'User deleted successfully' });
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('throws NotFound when the user does not exist', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.remove('missing', caller())).rejects.toThrow(
      'User not found',
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('UsersService.findAll', () => {
  it('excludes soft deleted users', async () => {
    const prisma = {
      user: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;

    const service = new UsersService(prisma);
    await service.findAll();

    const args = (prisma.user as unknown as { findMany: ReturnType<typeof vi.fn> })
      .findMany.mock.calls[0]![0];
    expect(args.where).toEqual({ deletedAt: null });
  });
});

describe('UsersService.getProfile', () => {
  let prisma: {
    user: { findFirst: ReturnType<typeof vi.fn> };
  };
  let service: UsersService;

  const buildUser = (overrides: Record<string, unknown> = {}) => ({
    id: 'user-1',
    email: 'user@kinobecho.dev',
    phone: '+8801700000001',
    name: 'Test User',
    avatarUrl: null,
    isVerified: true,
    role: UserRole.VENDOR,
    roleId: 'role-1',
    vendor: { id: 'vendor-1', status: VendorStatus.ACTIVE },
    rbacRole: {
      id: 'role-1',
      name: 'vendor',
      permissions: [
        { permission: { key: 'product:create' } },
        { permission: { key: 'order:update:own' } },
      ],
    },
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  });

  beforeEach(() => {
    prisma = { user: { findFirst: vi.fn() } };
    service = new UsersService(prisma as unknown as PrismaService);
  });

  it('returns permissions resolved from the rbac role', async () => {
    prisma.user.findFirst.mockResolvedValue(buildUser());

    const profile = await service.getProfile('user-1');

    expect(profile.permissions).toEqual(['product:create', 'order:update:own']);
  });

  it('returns the role and the vendor id', async () => {
    prisma.user.findFirst.mockResolvedValue(buildUser());

    const profile = await service.getProfile('user-1');

    expect(profile.role).toBe(UserRole.VENDOR);
    expect(profile.vendorId).toBe('vendor-1');
    expect(profile.roleName).toBe('vendor');
  });

  it('returns vendorId null when the user has no vendor profile', async () => {
    prisma.user.findFirst.mockResolvedValue(buildUser({ vendor: null }));

    const profile = await service.getProfile('user-1');

    expect(profile.vendorId).toBeNull();
    expect(profile.vendorStatus).toBeNull();
  });

  it('falls back to USER_ROLE_PERMISSIONS when no role is assigned', async () => {
    prisma.user.findFirst.mockResolvedValue(
      buildUser({ roleId: null, rbacRole: null, vendor: null }),
    );

    const profile = await service.getProfile('user-1');

    expect(profile.permissions).toEqual([...USER_ROLE_PERMISSIONS]);
    expect(profile.roleName).toBeNull();
  });

  it('falls back to USER_ROLE_PERMISSIONS when the role has no permissions yet', async () => {
    prisma.user.findFirst.mockResolvedValue(
      buildUser({
        rbacRole: { id: 'role-1', name: 'vendor', permissions: [] },
      }),
    );

    const profile = await service.getProfile('user-1');

    expect(profile.permissions).toEqual([...USER_ROLE_PERMISSIONS]);
  });

  it('excludes soft deleted users', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    await expect(service.getProfile('user-1')).rejects.toThrow('User not found');

    const args = prisma.user.findFirst.mock.calls[0]![0];
    expect(args.where).toEqual({ id: 'user-1', deletedAt: null });
  });
});