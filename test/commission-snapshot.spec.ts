import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { CommissionService } from '../src/modules/payouts/commission.service';
import { PayoutsService } from '../src/modules/payouts/payouts.service';
import { OrderStatusService } from '../src/modules/shipping/order-status.service';
import { PrismaService } from '../src/database/prisma.service';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { OrderCancellationService } from '../src/modules/orders/order-cancellation.service';
import { AuthenticatedUser } from '../src/common/guards/roles.guard';
import { UserRole, OrderStatus } from '@prisma/client';

const dec = (v: string) => new Prisma.Decimal(v);

describe('commission snapshot at delivery', () => {
  let tx: {
    order: { update: ReturnType<typeof vi.fn> };
    vendor: { findUnique: ReturnType<typeof vi.fn> };
    transaction: { create: ReturnType<typeof vi.fn> };
    orderStatusHistory: { create: ReturnType<typeof vi.fn> };
  };
  let prisma: {
    order: { findUnique: ReturnType<typeof vi.fn> };
    vendor: { findUnique: ReturnType<typeof vi.fn> };
    transaction: {
      create: ReturnType<typeof vi.fn>;
      groupBy: ReturnType<typeof vi.fn>;
    };
    orderStatusHistory: { create: ReturnType<typeof vi.fn> };
    transactionOrder: { findMany: ReturnType<typeof vi.fn> };
    productVariant: { findMany: ReturnType<typeof vi.fn> };
    user: { count: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let status: OrderStatusService;
  let commission: CommissionService;

  const vendorUser = {
    id: 'u1',
    email: 'v@example.com',
    name: 'V',
    role: UserRole.VENDOR,
    roleId: null,
    vendor: { id: 'vendor-1' },
  } as unknown as AuthenticatedUser;

  const buildOrder = (overrides: Record<string, unknown> = {}) => ({
    id: 'order-1',
    orderNumber: 'ORD-1',
    buyerId: 'buyer-1',
    vendorId: 'vendor-1',
    status: OrderStatus.SHIPPED,
    subtotal: dec('1000.00'),
    discountTotal: dec('100.00'),
    grandTotal: dec('990.00'),
    commissionRate: null,
    commissionAmount: null,
    vendorEarning: null,
    paymentMethod: null,
    paymentStatus: 'UNPAID',
    ...overrides,
  });

  beforeEach(() => {
    tx = {
      order: { update: vi.fn().mockResolvedValue({}) },
      vendor: { findUnique: vi.fn() },
      transaction: { create: vi.fn().mockResolvedValue({}) },
      orderStatusHistory: { create: vi.fn().mockResolvedValue({}) },
    };

    prisma = {
      order: { findUnique: vi.fn() },
      vendor: { findUnique: vi.fn() },
      transaction: {
        create: vi.fn().mockResolvedValue({}),
        groupBy: vi.fn().mockResolvedValue([]),
      },
      orderStatusHistory: { create: vi.fn().mockResolvedValue({}) },
      transactionOrder: { findMany: vi.fn().mockResolvedValue([]) },
      productVariant: { findMany: vi.fn().mockResolvedValue([]) },
      user: { count: vi.fn().mockResolvedValue(0) },
      $transaction: vi.fn(),
    };

    prisma.$transaction.mockImplementation(
      (cb: (client: unknown) => unknown) => cb(tx),
    );

    commission = new CommissionService();

    status = new OrderStatusService(
      prisma as unknown as PrismaService,
      { settleCodOnDelivery: vi.fn() } as unknown as PaymentsService,
      {} as unknown as OrderCancellationService,
      commission,
    );
  });

  it('snapshots the vendor rate, commission and earning onto the order', async () => {
    prisma.order.findUnique.mockResolvedValue(buildOrder());
    tx.vendor.findUnique.mockResolvedValue({
      id: 'vendor-1',
      commissionRate: dec('10.00'),
    });

    await status.moveToSystem(undefined, 'order-1', OrderStatus.DELIVERED);

    expect(tx.order.update).toHaveBeenCalledWith({
      where: { id: 'order-1' },
      data: {
        commissionRate: dec('10.00'),
        // base 900 x 10% = 90
        commissionAmount: dec('90.00'),
        vendorEarning: dec('810.00'),
      },
    });
  });

  it('excludes shipping from the commission base', async () => {
    prisma.order.findUnique.mockResolvedValue(
      buildOrder({ grandTotal: dec('990.00') }),
    );
    tx.vendor.findUnique.mockResolvedValue({
      id: 'vendor-1',
      commissionRate: dec('10.00'),
    });

    await status.moveToSystem(undefined, 'order-1', OrderStatus.DELIVERED);

    // grandTotal is 990 (including 90 shipping) but commission is charged on the
    // 900 merchandise value, not on 990.
    const call = tx.order.update.mock.calls.find(
      (c) => (c[0] as { data: { commissionAmount?: unknown } }).data.commissionAmount,
    );
    expect((call![0] as { data: { commissionAmount: Prisma.Decimal } }).data.commissionAmount.toFixed(2)).toBe('90.00');
  });

  it('books a completed COMMISSION transaction from vendor to platform', async () => {
    prisma.order.findUnique.mockResolvedValue(buildOrder());
    tx.vendor.findUnique.mockResolvedValue({
      id: 'vendor-1',
      commissionRate: dec('10.00'),
    });

    await status.moveToSystem(undefined, 'order-1', OrderStatus.DELIVERED);

    expect(tx.transaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'COMMISSION',
        direction: 'CREDIT',
        status: 'COMPLETED',
        fromType: 'VENDOR',
        fromId: 'vendor-1',
        toType: 'PLATFORM',
        orderId: 'order-1',
        vendorId: 'vendor-1',
        completedAt: expect.any(Date),
      }),
    });
  });

  it('ignores a later change to the vendor rate', async () => {
    prisma.order.findUnique.mockResolvedValue(buildOrder());
    tx.vendor.findUnique.mockResolvedValue({
      id: 'vendor-1',
      commissionRate: dec('10.00'),
    });

    await status.moveToSystem(undefined, 'order-1', OrderStatus.DELIVERED);

    const snapshot = tx.order.update.mock.calls.find((c) =>
      (c[0] as { data: { commissionAmount?: unknown } }).data.commissionAmount,
    )![0] as { data: { commissionAmount: Prisma.Decimal } };
    const snapshotted = snapshot.data.commissionAmount.toFixed(2);

    // The platform now raises the rate to 30%.
    tx.vendor.findUnique.mockResolvedValue({
      id: 'vendor-1',
      commissionRate: dec('30.00'),
    });

    // A fresh order delivered now is charged the new rate...
    prisma.order.findUnique.mockResolvedValue(buildOrder({ id: 'order-2' }));
    await status.moveToSystem(undefined, 'order-2', OrderStatus.DELIVERED);

    const second = tx.order.update.mock.calls.filter((c) =>
      (c[0] as { data: { commissionAmount?: unknown } }).data.commissionAmount,
    )[1]![0] as { data: { commissionAmount: Prisma.Decimal } };

    expect(second.data.commissionAmount.toFixed(2)).toBe('270.00');

    // ...while order-1 keeps the 90.00 it was delivered at. The stored value is
    // what a payout reads, so the rate change cannot reach back.
    expect(snapshotted).toBe('90.00');
  });

  it('does not snapshot twice for an already-snapshotted order', async () => {
    prisma.order.findUnique.mockResolvedValue(
      buildOrder({
        commissionRate: dec('10.00'),
        commissionAmount: dec('90.00'),
        vendorEarning: dec('810.00'),
      }),
    );

    await status.moveToSystem(undefined, 'order-1', OrderStatus.DELIVERED);

    expect(tx.transaction.create).not.toHaveBeenCalled();
    expect(tx.vendor.findUnique).not.toHaveBeenCalled();
  });

  it('skips the snapshot when the vendor is missing', async () => {
    prisma.order.findUnique.mockResolvedValue(buildOrder());
    tx.vendor.findUnique.mockResolvedValue(null);

    await expect(
      status.moveToSystem(undefined, 'order-1', OrderStatus.DELIVERED),
    ).resolves.toBeDefined();

    expect(tx.transaction.create).not.toHaveBeenCalled();
  });

  it('does not snapshot for a non-DELIVERED transition', async () => {
    prisma.order.findUnique.mockResolvedValue(
      buildOrder({ status: OrderStatus.PENDING }),
    );
    tx.vendor.findUnique.mockResolvedValue({
      id: 'vendor-1',
      commissionRate: dec('10.00'),
    });

    await status.moveToSystem(undefined, 'order-1', OrderStatus.CONFIRMED);

    expect(tx.transaction.create).not.toHaveBeenCalled();
  });

  it('snapshots on the manual vendor path too', async () => {
    prisma.order.findUnique.mockResolvedValue(buildOrder());
    tx.vendor.findUnique.mockResolvedValue({
      id: 'vendor-1',
      commissionRate: dec('12.50'),
    });

    await status.moveTo(vendorUser, 'order-1', OrderStatus.DELIVERED);

    const snapshot = tx.order.update.mock.calls.find((c) =>
      (c[0] as { data: { commissionAmount?: unknown } }).data.commissionAmount,
    )![0] as { data: { commissionAmount: Prisma.Decimal } };

    // 900 x 12.5% = 112.50
    expect(snapshot.data.commissionAmount.toFixed(2)).toBe('112.50');
  });
});

describe('PayoutsService amount', () => {
  let prisma: {
    vendor: { findUnique: ReturnType<typeof vi.fn> };
    order: { findMany: ReturnType<typeof vi.fn> };
    transaction: {
      create: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    transactionOrder: { findMany: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let payouts: PayoutsService;

  const vendorUser = {
    id: 'u1',
    email: 'v@example.com',
    name: 'V',
    role: UserRole.VENDOR,
    roleId: null,
    vendor: { id: 'vendor-1' },
  } as unknown as AuthenticatedUser;

  beforeEach(() => {
    prisma = {
      vendor: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'vendor-1',
          payoutMethod: 'BANK',
          // Deliberately a rate that would give a wrong answer if the payout
          // recomputed from it.
          commissionRate: dec('50.00'),
        }),
      },
      order: { findMany: vi.fn() },
      transaction: {
        create: vi.fn().mockResolvedValue({ id: 'payout-1' }),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({}),
      },
      transactionOrder: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(),
    };
    prisma.$transaction.mockImplementation(
      (cb: (client: unknown) => unknown) =>
        cb({
          transaction: prisma.transaction,
        }),
    );

    payouts = new PayoutsService(prisma as unknown as PrismaService);
  });

  const orders = (rows: Record<string, unknown>[]) =>
    prisma.order.findMany.mockResolvedValue(rows);

  it('sums the snapshotted vendorEarning', async () => {
    orders([
      {
        id: 'o1',
        orderNumber: 'ORD-1',
        vendorId: 'vendor-1',
        status: OrderStatus.DELIVERED,
        grandTotal: dec('990.00'),
        vendorEarning: dec('810.00'),
      },
      {
        id: 'o2',
        orderNumber: 'ORD-2',
        vendorId: 'vendor-1',
        status: OrderStatus.DELIVERED,
        grandTotal: dec('450.00'),
        vendorEarning: dec('400.00'),
      },
    ]);

    await payouts.requestPayout(vendorUser, ['o1', 'o2']);

    const created = prisma.transaction.create.mock.calls[0]![0] as {
      data: { amount: Prisma.Decimal; type: string };
    };

    expect(created.data.type).toBe('PAYOUT');
    expect(created.data.amount.toFixed(2)).toBe('1210.00');
  });

  it('ignores the current vendor rate entirely', async () => {
    // vendor.commissionRate is 50%, which would yield 495 + 225 = 720 if the
    // payout recomputed. The snapshots say 810 + 400.
    orders([
      {
        id: 'o1',
        orderNumber: 'ORD-1',
        vendorId: 'vendor-1',
        status: OrderStatus.DELIVERED,
        grandTotal: dec('990.00'),
        vendorEarning: dec('810.00'),
      },
      {
        id: 'o2',
        orderNumber: 'ORD-2',
        vendorId: 'vendor-1',
        status: OrderStatus.DELIVERED,
        grandTotal: dec('450.00'),
        vendorEarning: dec('400.00'),
      },
    ]);

    await payouts.requestPayout(vendorUser, ['o1', 'o2']);

    const created = prisma.transaction.create.mock.calls[0]![0] as {
      data: { amount: Prisma.Decimal };
    };

    expect(created.data.amount.toFixed(2)).toBe('1210.00');
    expect(created.data.amount.toFixed(2)).not.toBe('720.00');
  });

  it('refuses to pay an order with no commission snapshot', async () => {
    orders([
      {
        id: 'o1',
        orderNumber: 'ORD-1',
        vendorId: 'vendor-1',
        status: OrderStatus.DELIVERED,
        grandTotal: dec('990.00'),
        vendorEarning: null,
      },
    ]);

    await expect(payouts.requestPayout(vendorUser, ['o1'])).rejects.toThrow(
      /no vendor earning/i,
    );
    expect(prisma.transaction.create).not.toHaveBeenCalled();
  });

  it('pays out a single order exactly', async () => {
    orders([
      {
        id: 'o1',
        orderNumber: 'ORD-1',
        vendorId: 'vendor-1',
        status: OrderStatus.DELIVERED,
        grandTotal: dec('990.00'),
        vendorEarning: dec('123.45'),
      },
    ]);

    await payouts.requestPayout(vendorUser, ['o1']);

    const created = prisma.transaction.create.mock.calls[0]![0] as {
      data: { amount: Prisma.Decimal };
    };
    expect(created.data.amount.toFixed(2)).toBe('123.45');
  });
});
