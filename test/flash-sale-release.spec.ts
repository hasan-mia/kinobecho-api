import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderStatus, PaymentGateway, Prisma, TransactionStatus } from '@prisma/client';
import { OrderCancellationService } from '../src/modules/orders/order-cancellation.service';
import { PrismaService } from '../src/database/prisma.service';

const dec = (v: string) => new Prisma.Decimal(v);

function buildOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    buyerId: 'buyer-1',
    vendorId: 'vendor-1',
    status: OrderStatus.PENDING,
    couponId: null,
    discountTotal: dec('0'),
    paymentMethod: PaymentGateway.BKASH,
    ...overrides,
  };
}

function build() {
  const groupBy = vi.fn().mockImplementation(async (args: any) =>
    args.by.includes('flashSaleItemId') ? saleGroups : variantGroups,
  );

  const flashSaleItemUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const productVariantUpdate = vi.fn().mockResolvedValue({});

  const tx = {
    order: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
    orderItem: { groupBy },
    productVariant: { update: productVariantUpdate },
    coupon: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    transaction: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    orderStatusHistory: { create: vi.fn().mockResolvedValue({}) },
    flashSaleItem: { updateMany: flashSaleItemUpdateMany },
  };

  const prisma = {
    $transaction: vi.fn(async (cb: (t: unknown) => unknown) => cb(tx)),
  };

  return {
    tx,
    prisma,
    flashSaleItemUpdateMany,
    service: new OrderCancellationService(prisma as unknown as PrismaService),
  };
}

let saleGroups: unknown[] = [];
let variantGroups: unknown[] = [];

beforeEach(() => {
  saleGroups = [];
  variantGroups = [];
});

describe('OrderCancellationService — flash sale release', () => {
  it('gives the budget back for a cancelled order', async () => {
    saleGroups = [{ flashSaleItemId: 'fsi-1', _sum: { qty: 2 } }];

    const h = build();
    h.tx.order.findUnique.mockResolvedValue(buildOrder());

    const result = await h.service.cancelOrder('order-1', 'buyer-1', 'changed mind');

    expect(h.flashSaleItemUpdateMany).toHaveBeenCalledWith({
      where: { id: 'fsi-1', soldCount: { gt: 0 } },
      data: { soldCount: { decrement: 2 } },
    });
    expect(result.flashSaleReleased).toEqual([
      { flashSaleItemId: 'fsi-1', qty: 2 },
    ]);
  });

  it('aggregates several lines on the same sale item into one decrement', async () => {
    saleGroups = [{ flashSaleItemId: 'fsi-1', _sum: { qty: 3 } }];

    const h = build();
    h.tx.order.findUnique.mockResolvedValue(buildOrder());

    await h.service.cancelOrder('order-1', 'buyer-1');

    // One write per promotion, not one per order line.
    expect(h.flashSaleItemUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('skips orders that bought nothing on sale', async () => {
    saleGroups = [];

    const h = build();
    h.tx.order.findUnique.mockResolvedValue(buildOrder());

    const result = await h.service.cancelOrder('order-1', 'buyer-1');

    expect(h.flashSaleItemUpdateMany).not.toHaveBeenCalled();
    expect(result.flashSaleReleased).toEqual([]);
  });

  it('releases nothing for an ordinary order', async () => {
    variantGroups = [{ productVariantId: 'v-1', _sum: { qty: 1 } }];

    const h = build();
    h.tx.order.findUnique.mockResolvedValue(buildOrder());

    const result = await h.service.cancelOrder('order-1', 'buyer-1');

    expect(result.restocked).toEqual([{ productVariantId: 'v-1', qty: 1 }]);
    expect(result.flashSaleReleased).toEqual([]);
  });

  it('does not drive soldCount below zero', async () => {
    saleGroups = [{ flashSaleItemId: 'fsi-1', _sum: { qty: 5 } }];
    // The guard matched nothing: the counter was already at zero.
    const h = build();
    h.tx.order.findUnique.mockResolvedValue(buildOrder());
    h.flashSaleItemUpdateMany.mockResolvedValue({ count: 0 });

    const result = await h.service.cancelOrder('order-1', 'buyer-1');

    // The cancellation still succeeds; there was simply nothing to give back.
    expect(result.cancelled).toBe(true);
    expect(result.flashSaleReleased).toEqual([]);
  });

  it('still releases variant stock for a sale order', async () => {
    // Both budgets move together, so neither is half-applied.
    saleGroups = [{ flashSaleItemId: 'fsi-1', _sum: { qty: 1 } }];
    variantGroups = [{ productVariantId: 'v-1', _sum: { qty: 1 } }];

    const h = build();
    h.tx.order.findUnique.mockResolvedValue(buildOrder());

    const result = await h.service.cancelOrder('order-1', 'buyer-1');

    expect(h.tx.productVariant.update).toHaveBeenCalledWith({
      where: { id: 'v-1' },
      data: { stock: { increment: 1 } },
    });
    expect(result.flashSaleReleased).toHaveLength(1);
  });

  it('releases nothing when the status precondition fails', async () => {
    saleGroups = [{ flashSaleItemId: 'fsi-1', _sum: { qty: 1 } }];

    const h = build();
    h.tx.order.findUnique.mockResolvedValue(
      buildOrder({ status: OrderStatus.CONFIRMED }),
    );

    const result = await h.service.cancelOrder('order-1', null, 'expired', {
      requireStatus: OrderStatus.PENDING,
    });

    // A payment webhook won the race; the caller's precondition is stale.
    expect(result.cancelled).toBe(false);
    expect(h.flashSaleItemUpdateMany).not.toHaveBeenCalled();
  });

  it('does not double-release when the order is already cancelled', async () => {
    saleGroups = [{ flashSaleItemId: 'fsi-1', _sum: { qty: 1 } }];

    const h = build();
    h.tx.order.findUnique.mockResolvedValue(
      buildOrder({ status: OrderStatus.CANCELLED }),
    );

    const result = await h.service.cancelOrder('order-1', 'buyer-1');

    // Idempotent: a re-run of the expiry sweep must not hand back the budget
    // a second time, which would let a buyer exceed perUserLimit.
    expect(result.cancelled).toBe(false);
    expect(h.flashSaleItemUpdateMany).not.toHaveBeenCalled();
  });

  it('is transactional with the cancellation itself', async () => {
    saleGroups = [{ flashSaleItemId: 'fsi-1', _sum: { qty: 1 } }];

    const h = build();
    h.tx.order.findUnique.mockResolvedValue(buildOrder());

    await h.service.cancelOrder('order-1', 'buyer-1');

    // The release runs inside the same $transaction as the status change, so a
    // failure cannot leave the order CANCELLED with the budget still consumed.
    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.tx.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: OrderStatus.CANCELLED }),
      }),
    );
  });

  it('closes out open payments as before', async () => {
    const h = build();
    h.tx.order.findUnique.mockResolvedValue(buildOrder());

    const result = await h.service.cancelOrder('order-1', 'buyer-1');

    expect(h.tx.transaction.updateMany).toHaveBeenCalledWith({
      where: { orderId: 'order-1', status: TransactionStatus.PENDING },
      data: { status: TransactionStatus.FAILED },
    });
    expect(result.transactionsFailed).toBe(1);
  });
});
