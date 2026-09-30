import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderStatus, Prisma, UserRole } from '@prisma/client';
import { OrderStatusService } from '../src/modules/shipping/order-status.service';
import { CommissionService } from '../src/modules/payouts/commission.service';
import { PrismaService } from '../src/database/prisma.service';
import { AuthenticatedUser } from '../src/common/guards/roles.guard';

const dec = (v: string) => new Prisma.Decimal(v);

const vendorUser = {
  id: 'u1',
  email: 'v@example.com',
  name: 'V',
  role: UserRole.VENDOR,
  roleId: null,
  vendor: { id: 'vendor-1' },
} as unknown as AuthenticatedUser;

describe('soldCount at delivery', () => {
  let prisma: any;
  let tx: any;
  let status: OrderStatusService;
  let search: { enqueueUpsert: ReturnType<typeof vi.fn> };

  const order = {
    id: 'order-1',
    orderNumber: 'ORD-1',
    buyerId: 'buyer-1',
    vendorId: 'vendor-1',
    status: OrderStatus.SHIPPED,
    subtotal: dec('300.00'),
    discountTotal: dec('0.00'),
    grandTotal: dec('300.00'),
    commissionRate: null,
    commissionAmount: null,
    vendorEarning: null,
    paymentMethod: null,
    paymentStatus: 'PAID',
  };

  beforeEach(() => {
    tx = {
      order: { update: vi.fn().mockResolvedValue({}) },
      orderItem: { findMany: vi.fn().mockResolvedValue([]) },
      product: { update: vi.fn().mockResolvedValue({}) },
      vendor: { findUnique: vi.fn().mockResolvedValue(null) },
      transaction: { create: vi.fn().mockResolvedValue({}) },
      orderStatusHistory: { create: vi.fn().mockResolvedValue({}) },
    };

    prisma = {
      order: { findUnique: vi.fn().mockResolvedValue(order) },
      $transaction: vi.fn((cb: (client: unknown) => unknown) => cb(tx)),
    };

    search = { enqueueUpsert: vi.fn().mockResolvedValue(undefined) };

    status = new OrderStatusService(
      prisma as unknown as PrismaService,
      { settleCodOnDelivery: vi.fn().mockResolvedValue(false) } as never,
      {} as never,
      new CommissionService(),
      search as never,
    );
  });

  const line = (variantId: string, productId: string, qty: number) => ({
    productVariantId: variantId,
    qty,
    productVariant: { productId },
  });

  it('adds the delivered units to each product', async () => {
    tx.orderItem.findMany.mockResolvedValue([line('v1', 'p1', 2)]);

    await status.moveTo(vendorUser, 'order-1', OrderStatus.DELIVERED);

    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { soldCount: { increment: 2 } },
    });
  });

  it('aggregates several variants of the same product into one write', async () => {
    tx.orderItem.findMany.mockResolvedValue([
      line('v1', 'p1', 2),
      line('v2', 'p1', 3),
    ]);

    await status.moveTo(vendorUser, 'order-1', OrderStatus.DELIVERED);

    const productWrites = (tx.product.update.mock.calls as unknown as [
      { where: { id: string }; data: { soldCount: { increment: number } } },
      unknown,
    ][]).filter((call) => call[0].where.id === 'p1');

    // Three increments of 2 and 3 would drift; one increment of 5 cannot.
    expect(productWrites).toHaveLength(1);
    expect(productWrites[0]![0].data.soldCount.increment).toBe(5);
  });

  it('counts separate products separately', async () => {
    tx.orderItem.findMany.mockResolvedValue([
      line('v1', 'p1', 2),
      line('v2', 'p2', 1),
    ]);

    await status.moveTo(vendorUser, 'order-1', OrderStatus.DELIVERED);

    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { soldCount: { increment: 2 } },
    });
    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: 'p2' },
      data: { soldCount: { increment: 1 } },
    });
  });

  it('counts inside the delivery transaction, so a failed delivery moves nothing', async () => {
    tx.orderItem.findMany.mockResolvedValue([line('v1', 'p1', 2)]);
    prisma.$transaction.mockImplementation((cb: (c: unknown) => unknown) => {
      tx.product.update.mockImplementation(() => {
        throw new Error('write failed');
      });
      return cb(tx);
    });

    await expect(
      status.moveTo(vendorUser, 'order-1', OrderStatus.DELIVERED),
    ).rejects.toThrow('write failed');
  });

  it('does not count on a non-delivery transition', async () => {
    tx.orderItem.findMany.mockResolvedValue([line('v1', 'p1', 2)]);

    // The order object is re-read per transition, so the second move must see
    // the state the first one committed.
    await status.moveTo(vendorUser, 'order-1', OrderStatus.DELIVERED);
    prisma.order.findUnique.mockResolvedValue({
      ...order,
      status: OrderStatus.DELIVERED,
    });
    tx.product.update.mockClear();

    await status.moveTo(vendorUser, 'order-1', OrderStatus.RETURNED);

    expect(tx.product.update).not.toHaveBeenCalled();
  });

  it('queues a re-index so the popular sort sees the new count', async () => {
    tx.orderItem.findMany.mockResolvedValue([line('v1', 'p1', 2)]);

    await status.moveTo(vendorUser, 'order-1', OrderStatus.DELIVERED);

    expect(search.enqueueUpsert).toHaveBeenCalledWith('p1');
  });

  it('queues each product once, even when it appears on several lines', async () => {
    tx.orderItem.findMany.mockResolvedValue([
      line('v1', 'p1', 2),
      line('v2', 'p1', 1),
    ]);

    await status.moveTo(vendorUser, 'order-1', OrderStatus.DELIVERED);

    expect(search.enqueueUpsert).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the order has no lines', async () => {
    tx.orderItem.findMany.mockResolvedValue([]);

    await status.moveTo(vendorUser, 'order-1', OrderStatus.DELIVERED);

    expect(tx.product.update).not.toHaveBeenCalled();
    expect(search.enqueueUpsert).not.toHaveBeenCalled();
  });
});
