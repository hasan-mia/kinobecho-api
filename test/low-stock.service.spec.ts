import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LowStockService } from '../src/modules/payouts/low-stock.service';
import { PrismaService } from '../src/database/prisma.service';
import { NotificationService } from '../src/modules/notification/notification.service';

describe('LowStockService', () => {
  let prisma: {
    productVariant: { updateMany: ReturnType<typeof vi.fn> };
    vendor: { findUnique: ReturnType<typeof vi.fn> };
    user: { findUnique: ReturnType<typeof vi.fn> };
  };
  let notifications: {
    sendTransactionalEmail: ReturnType<typeof vi.fn>;
    sendPushToUser: ReturnType<typeof vi.fn>;
  };
  let service: LowStockService;

  const variant = (overrides: Record<string, unknown> = {}) => ({
    id: 'variant-1',
    sku: 'SKU-1',
    stock: 3,
    lowStockAlertAt: 5,
    product: { id: 'p1', name: 'Widget', vendorId: 'vendor-1' },
    ...overrides,
  });

  beforeEach(() => {
    prisma = {
      productVariant: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      vendor: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'vendor-1',
          businessName: 'Acme',
          userId: 'user-1',
        }),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({ email: 'v@example.com' }),
      },
    };

    notifications = {
      sendTransactionalEmail: vi.fn().mockResolvedValue({ success: true }),
      sendPushToUser: vi.fn().mockResolvedValue({ success: true }),
    };

    service = new LowStockService(
      prisma as unknown as PrismaService,
      notifications as unknown as NotificationService,
    );
  });

  it('notifies once when stock crosses below the threshold', async () => {
    await service.checkAfterStockChange([variant({ stock: 3, lowStockAlertAt: 5 })]);

    expect(notifications.sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(notifications.sendPushToUser).toHaveBeenCalledTimes(1);
  });

  it('notifies when stock lands exactly on the threshold', async () => {
    await service.checkAfterStockChange([variant({ stock: 5, lowStockAlertAt: 5 })]);

    expect(notifications.sendTransactionalEmail).toHaveBeenCalledTimes(1);
  });

  it('does not notify above the threshold', async () => {
    await service.checkAfterStockChange([variant({ stock: 6, lowStockAlertAt: 5 })]);

    expect(notifications.sendTransactionalEmail).not.toHaveBeenCalled();
    expect(notifications.sendPushToUser).not.toHaveBeenCalled();
  });

  it('claims the alert flag before sending, so a repeat is suppressed', async () => {
    // updateMany with the null predicate is the atomic dedup guard: a second
    // caller matches no rows and never sends.
    prisma.productVariant.updateMany.mockResolvedValueOnce({ count: 1 });

    await service.checkAfterStockChange([variant({ stock: 1, lowStockAlertAt: 5 })]);
    expect(notifications.sendPushToUser).toHaveBeenCalledTimes(1);

    prisma.productVariant.updateMany.mockResolvedValue({ count: 0 });
    await service.checkAfterStockChange([variant({ stock: 1, lowStockAlertAt: 5 })]);
    expect(notifications.sendPushToUser).toHaveBeenCalledTimes(1);
  });

  it('resets the flag when stock is restocked above the threshold', async () => {
    await service.checkAfterStockChange([variant({ stock: 50, lowStockAlertAt: 5 })]);

    expect(prisma.productVariant.updateMany).toHaveBeenCalledWith({
      where: { id: 'variant-1', lowStockNotifiedAt: { not: null } },
      data: { lowStockNotifiedAt: null },
    });
  });

  it('re-arms the alert after a restock, so a second dip warns again', async () => {
    const claims: number[] = [];
    prisma.productVariant.updateMany.mockImplementation(
      async (arg: { data: { lowStockNotifiedAt: Date | null } }) => {
        if (arg.data.lowStockNotifiedAt === null) {
          claims.push(0);
          return { count: 1 };
        }
        // Simulate the flag being unset after a restock.
        claims.push(1);
        return { count: 1 };
      },
    );

    await service.checkAfterStockChange([variant({ stock: 2, lowStockAlertAt: 5 })]);
    await service.checkAfterStockChange([variant({ stock: 50, lowStockAlertAt: 5 })]);
    await service.checkAfterStockChange([variant({ stock: 1, lowStockAlertAt: 5 })]);

    expect(notifications.sendPushToUser).toHaveBeenCalledTimes(2);
    expect(claims).toEqual([1, 0, 1]);
  });

  it('sends both email and push', async () => {
    await service.checkAfterStockChange([variant()]);

    expect(notifications.sendTransactionalEmail).toHaveBeenCalledWith(
      'user-1',
      'v@example.com',
      'Low stock alert',
      'low-stock-alert',
      expect.objectContaining({ stock: '3', threshold: '5', sku: 'SKU-1' }),
    );
    expect(notifications.sendPushToUser).toHaveBeenCalledWith(
      'user-1',
      'Low stock alert',
      expect.stringContaining('SKU-1'),
      expect.objectContaining({ productId: 'p1', variantId: 'variant-1' }),
    );
  });

  it('still sends the other channel when one fails', async () => {
    notifications.sendPushToUser.mockRejectedValue(new Error('FCM not configured'));

    await expect(
      service.checkAfterStockChange([variant()]),
    ).resolves.toBeUndefined();

    expect(notifications.sendTransactionalEmail).toHaveBeenCalledTimes(1);
  });

  it('skips notification when the vendor has no user', async () => {
    prisma.vendor.findUnique.mockResolvedValue({
      id: 'vendor-1',
      businessName: 'Acme',
      userId: null,
    });

    await service.checkAfterStockChange([variant()]);

    expect(notifications.sendTransactionalEmail).not.toHaveBeenCalled();
    // The flag is still claimed, so a later real user is not spammed retroactively.
    expect(prisma.productVariant.updateMany).toHaveBeenCalled();
  });

  it('handles several variants in one checkout', async () => {
    await service.checkAfterStockChange([
      variant({ id: 'v1', stock: 1 }),
      variant({ id: 'v2', stock: 50, lowStockAlertAt: 5 }),
      variant({ id: 'v3', stock: 5, lowStockAlertAt: 5 }),
    ]);

    // Two low, one healthy.
    expect(notifications.sendPushToUser).toHaveBeenCalledTimes(2);
  });

  it('does nothing for an empty variant list', async () => {
    await service.checkAfterStockChange([]);

    expect(notifications.sendPushToUser).not.toHaveBeenCalled();
    expect(prisma.productVariant.updateMany).not.toHaveBeenCalled();
  });
});
