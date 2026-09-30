import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma, TransactionStatus, TransactionType, UserRole } from '@prisma/client';
import { VendorAnalyticsService } from '../src/modules/payouts/vendor-analytics.service';
import { CommissionService } from '../src/modules/payouts/commission.service';
import { PrismaService } from '../src/database/prisma.service';
import { AuthenticatedUser } from '../src/common/guards/roles.guard';

const dec = (v: string) => new Prisma.Decimal(v);

describe('vendor wallet', () => {
  let prisma: {
    vendor: { findUnique: ReturnType<typeof vi.fn> };
    order: { findMany: ReturnType<typeof vi.fn> };
    transaction: {
      groupBy: ReturnType<typeof vi.fn>;
      aggregate: ReturnType<typeof vi.fn>;
    };
    transactionOrder: { findMany: ReturnType<typeof vi.fn> };
  };
  let service: VendorAnalyticsService;

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
          commissionRate: dec('10.00'),
        }),
      },
      order: { findMany: vi.fn() },
      transaction: {
        groupBy: vi.fn().mockResolvedValue([]),
        aggregate: vi.fn().mockResolvedValue({ _sum: { amount: null } }),
      },
      transactionOrder: { findMany: vi.fn().mockResolvedValue([]) },
    };

    service = new VendorAnalyticsService(
      prisma as unknown as PrismaService,
      new CommissionService(),
    );
  });

  const pending = (rows: Record<string, unknown>[]) =>
    prisma.order.findMany.mockResolvedValueOnce(rows);
  const delivered = (rows: Record<string, unknown>[]) =>
    prisma.order.findMany.mockResolvedValueOnce(rows);

  it('returns all five buckets as strings', async () => {
    pending([{ subtotal: dec('1000'), discountTotal: dec('0'), grandTotal: dec('1000') }]);
    delivered([{ id: 'o1', vendorEarning: dec('450.00') }]);
    prisma.transaction.groupBy.mockResolvedValue([
      { status: TransactionStatus.COMPLETED, _sum: { amount: dec('300.00') } },
      { status: TransactionStatus.PENDING, _sum: { amount: dec('150.00') } },
    ]);

    const wallet = await service.wallet(vendorUser);

    const buckets = [
      'pendingBalance',
      'availableBalance',
      'paidOut',
      'requestedBalance',
      'lifetimeEarnings',
    ] as const;

    for (const key of buckets) {
      expect(typeof wallet[key]).toBe('string');
    }

    expect(wallet.pendingBalance).toBe('900.00');
    expect(wallet.availableBalance).toBe('450.00');
    expect(wallet.paidOut).toBe('300.00');
    expect(wallet.requestedBalance).toBe('150.00');
    expect(wallet.lifetimeEarnings).toBe('450.00');
  });

  it('subtracts already-settled orders from available but not from lifetime', async () => {
    pending([]);
    delivered([
      { id: 'o1', vendorEarning: dec('450.00') },
      { id: 'o2', vendorEarning: dec('250.00') },
    ]);
    // o1 is already covered by a payout.
    prisma.transactionOrder.findMany.mockResolvedValue([{ orderId: 'o1' }]);
    prisma.transaction.groupBy.mockResolvedValue([
      { status: TransactionStatus.COMPLETED, _sum: { amount: dec('450.00') } },
    ]);

    const wallet = await service.wallet(vendorUser);

    // Available is the unsettled 250 only.
    expect(wallet.availableBalance).toBe('250.00');
    // Lifetime keeps counting every delivered order, settled or not.
    expect(wallet.lifetimeEarnings).toBe('700.00');
    // And the money is not counted twice: 250 available + 450 paid out.
    expect(
      dec(wallet.availableBalance).plus(wallet.paidOut).toFixed(2),
    ).toBe(wallet.lifetimeEarnings);
  });

  it('makes the buckets add up: available + requested + paidOut = lifetime', async () => {
    pending([]);
    delivered([
      { id: 'o1', vendorEarning: dec('100.00') },
      { id: 'o2', vendorEarning: dec('200.00') },
      { id: 'o3', vendorEarning: dec('300.00') },
    ]);
    // o1 paid out, o2 requested, o3 untouched.
    prisma.transactionOrder.findMany.mockResolvedValue([
      { orderId: 'o1' },
      { orderId: 'o2' },
    ]);
    prisma.transaction.groupBy.mockResolvedValue([
      { status: TransactionStatus.COMPLETED, _sum: { amount: dec('100.00') } },
      { status: TransactionStatus.PENDING, _sum: { amount: dec('200.00') } },
    ]);

    const wallet = await service.wallet(vendorUser);

    expect(wallet.availableBalance).toBe('300.00');
    expect(wallet.requestedBalance).toBe('200.00');
    expect(wallet.paidOut).toBe('100.00');
    expect(wallet.lifetimeEarnings).toBe('600.00');

    const sum = dec(wallet.availableBalance)
      .plus(wallet.requestedBalance)
      .plus(wallet.paidOut);

    expect(sum.toFixed(2)).toBe(wallet.lifetimeEarnings);
  });

  it('estimates pending balance at the current rate, excluding shipping', async () => {
    // grandTotal includes 100 shipping; commission is charged on merchandise.
    pending([
      { subtotal: dec('500.00'), discountTotal: dec('0'), grandTotal: dec('600.00') },
    ]);
    delivered([]);

    const wallet = await service.wallet(vendorUser);

    // 500 - 50 = 450, not 600 - 60 = 540.
    expect(wallet.pendingBalance).toBe('450.00');
  });

  it('reports zeros rather than null for an empty vendor', async () => {
    pending([]);
    delivered([]);

    const wallet = await service.wallet(vendorUser);

    expect(wallet.availableBalance).toBe('0.00');
    expect(wallet.paidOut).toBe('0.00');
    expect(wallet.requestedBalance).toBe('0.00');
    expect(wallet.lifetimeEarnings).toBe('0.00');
    expect(wallet.pendingBalance).toBe('0.00');
  });

  it('rejects a non-vendor', async () => {
    await expect(
      service.wallet({ role: UserRole.CUSTOMER } as unknown as AuthenticatedUser),
    ).rejects.toThrow(/Only vendors/);
  });

  it('always reports two decimal places', async () => {
    pending([{ subtotal: dec('100'), discountTotal: dec('0'), grandTotal: dec('100') }]);
    delivered([]);

    const wallet = await service.wallet(vendorUser);
    expect(wallet.pendingBalance).toMatch(/^\d+\.\d{2}$/);
  });

  it('nets outstanding refund debts off the available balance', async () => {
    pending([]);
    delivered([{ id: 'o1', vendorEarning: dec('450.00') }]);
    prisma.transaction.aggregate.mockResolvedValue({
      _sum: { amount: dec('120.00') },
    });

    const wallet = await service.wallet(vendorUser);

    // A refund on an already-paid order is money the platform owes back, so it
    // must reduce what the next payout can draw on — not sit in a bucket the
    // vendor has to remember to subtract.
    expect(wallet.availableBalance).toBe('330.00');
    expect(wallet.availableBalanceGross).toBe('450.00');
    expect(wallet.outstandingAdjustment).toBe('120.00');
  });

  it('never reports a negative available balance', async () => {
    pending([]);
    delivered([{ id: 'o1', vendorEarning: dec('50.00') }]);
    prisma.transaction.aggregate.mockResolvedValue({
      _sum: { amount: dec('120.00') },
    });

    const wallet = await service.wallet(vendorUser);

    expect(wallet.availableBalance).toBe('0.00');
    expect(wallet.outstandingAdjustment).toBe('120.00');
  });

  it('ignores debts a later payout already absorbed', async () => {
    pending([]);
    delivered([{ id: 'o1', vendorEarning: dec('450.00') }]);
    // The query that produces this is filtered on `offsetByPayout: null`, so a
    // settled debt simply is not in the result set.
    prisma.transaction.aggregate.mockResolvedValue({ _sum: { amount: null } });

    const wallet = await service.wallet(vendorUser);

    expect(prisma.transaction.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ offsetByPayout: null }),
      }),
    );
    expect(wallet.availableBalance).toBe('450.00');
    expect(wallet.outstandingAdjustment).toBe('0.00');
  });
});

describe('vendor analytics', () => {
  let prisma: {
    order: { findMany: ReturnType<typeof vi.fn> };
    productVariant: { findMany: ReturnType<typeof vi.fn> };
    vendor: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
    transaction: {
      groupBy: ReturnType<typeof vi.fn>;
      aggregate: ReturnType<typeof vi.fn>;
    };
    transactionOrder: { findMany: ReturnType<typeof vi.fn> };
    user: { count: ReturnType<typeof vi.fn> };
  };
  let service: VendorAnalyticsService;

  const vendorUser = {
    id: 'u1',
    role: UserRole.VENDOR,
    roleId: null,
    vendor: { id: 'vendor-1' },
  } as unknown as AuthenticatedUser;

  beforeEach(() => {
    prisma = {
      order: { findMany: vi.fn().mockResolvedValue([]) },
      productVariant: { findMany: vi.fn().mockResolvedValue([]) },
      vendor: {
        findUnique: vi.fn().mockResolvedValue({ id: 'vendor-1', commissionRate: dec('10') }),
        findMany: vi.fn().mockResolvedValue([]),
      },
      transaction: {
        groupBy: vi.fn().mockResolvedValue([]),
        aggregate: vi.fn().mockResolvedValue({ _sum: { amount: null } }),
      },
      transactionOrder: { findMany: vi.fn().mockResolvedValue([]) },
      user: { count: vi.fn().mockResolvedValue(0) },
    };

    service = new VendorAnalyticsService(
      prisma as unknown as PrismaService,
      new CommissionService(),
    );
  });

  it('computes sales total and average order value from subtotal minus discount', async () => {
    prisma.order.findMany.mockResolvedValue([
      {
        id: 'o1',
        status: 'DELIVERED',
        subtotal: dec('1000'),
        discountTotal: dec('100'),
        createdAt: new Date('2026-01-05T10:00:00Z'),
        items: [],
      },
      {
        id: 'o2',
        status: 'SHIPPED',
        subtotal: dec('500'),
        discountTotal: dec('0'),
        createdAt: new Date('2026-01-06T10:00:00Z'),
        items: [],
      },
    ]);

    const result = await service.analytics(vendorUser, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-31T23:59:59Z',
      groupBy: 'day',
    });

    expect(result.salesTotal).toBe('1400.00');
    expect(result.orderCount).toBe(2);
    expect(result.avgOrderValue).toBe('700.00');
  });

  it('groups the timeseries by day', async () => {
    prisma.order.findMany.mockResolvedValue([
      {
        id: 'o1',
        status: 'DELIVERED',
        subtotal: dec('100'),
        discountTotal: dec('0'),
        createdAt: new Date('2026-01-05T10:00:00Z'),
        items: [],
      },
      {
        id: 'o2',
        status: 'DELIVERED',
        subtotal: dec('200'),
        discountTotal: dec('0'),
        createdAt: new Date('2026-01-06T10:00:00Z'),
        items: [],
      },
      {
        id: 'o3',
        status: 'DELIVERED',
        subtotal: dec('300'),
        discountTotal: dec('0'),
        createdAt: new Date('2026-01-05T18:00:00Z'),
        items: [],
      },
    ]);

    const result = await service.analytics(vendorUser, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-31T23:59:59Z',
      groupBy: 'day',
    });

    expect(result.timeseries).toEqual([
      { bucket: '2026-01-05', salesTotal: '400.00', orderCount: 2 },
      { bucket: '2026-01-06', salesTotal: '200.00', orderCount: 1 },
    ]);
  });

  it('groups by month', async () => {
    prisma.order.findMany.mockResolvedValue([
      {
        id: 'o1',
        status: 'DELIVERED',
        subtotal: dec('100'),
        discountTotal: dec('0'),
        createdAt: new Date('2026-01-05T00:00:00Z'),
        items: [],
      },
      {
        id: 'o2',
        status: 'DELIVERED',
        subtotal: dec('100'),
        discountTotal: dec('0'),
        createdAt: new Date('2026-02-05T00:00:00Z'),
        items: [],
      },
    ]);

    const result = await service.analytics(vendorUser, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-01T00:00:00Z',
      groupBy: 'month',
    });

    expect(result.timeseries.map((t) => t.bucket)).toEqual(['2026-01', '2026-02']);
  });

  it('groups by ISO week', async () => {
    prisma.order.findMany.mockResolvedValue([
      {
        id: 'o1',
        status: 'DELIVERED',
        subtotal: dec('100'),
        discountTotal: dec('0'),
        createdAt: new Date('2026-01-05T00:00:00Z'),
        items: [],
      },
      {
        id: 'o2',
        status: 'DELIVERED',
        subtotal: dec('100'),
        discountTotal: dec('0'),
        createdAt: new Date('2026-01-12T00:00:00Z'),
        items: [],
      },
    ]);

    const result = await service.analytics(vendorUser, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-02-01T00:00:00Z',
      groupBy: 'week',
    });

    expect(result.timeseries[0]!.bucket).toMatch(/^2026-W\d{2}$/);
    expect(result.timeseries.length).toBe(2);
  });

  it('ranks the top ten products by revenue', async () => {
    prisma.order.findMany.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({
        id: `o${i}`,
        status: 'DELIVERED',
        subtotal: dec(String((i + 1) * 100)),
        discountTotal: dec('0'),
        createdAt: new Date('2026-01-05T00:00:00Z'),
        items: [
          {
            productVariantId: `v${i}`,
            qty: 1,
            lineTotal: dec(String((i + 1) * 100)),
          },
        ],
      })),
    );

    const result = await service.analytics(vendorUser, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-31T23:59:59Z',
    });

    expect(result.topProducts).toHaveLength(10);
    // Highest revenue first.
    expect(result.topProducts[0]!.revenue).toBe('1200.00');
    expect(Number(result.topProducts[0]!.revenue)).toBeGreaterThan(
      Number(result.topProducts[9]!.revenue),
    );
  });

  it('counts orders by status', async () => {
    prisma.order.findMany.mockResolvedValue([
      { id: 'o1', status: 'DELIVERED', subtotal: dec('1'), discountTotal: dec('0'), createdAt: new Date(), items: [] },
      { id: 'o2', status: 'DELIVERED', subtotal: dec('1'), discountTotal: dec('0'), createdAt: new Date(), items: [] },
      { id: 'o3', status: 'CANCELLED', subtotal: dec('1'), discountTotal: dec('0'), createdAt: new Date(), items: [] },
    ]);

    const result = await service.analytics(vendorUser, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-31T23:59:59Z',
    });

    expect(result.orderCountByStatus).toEqual({ DELIVERED: 2, CANCELLED: 1 });
  });

  it('rejects a half-specified window', async () => {
    await expect(
      service.analytics(vendorUser, { from: '2026-01-01T00:00:00Z' }),
    ).rejects.toThrow(/together/);
  });

  it('rejects an inverted window', async () => {
    await expect(
      service.analytics(vendorUser, {
        from: '2026-02-01T00:00:00Z',
        to: '2026-01-01T00:00:00Z',
      }),
    ).rejects.toThrow(/before/);
  });

  it('returns a zero average rather than dividing by zero', async () => {
    prisma.order.findMany.mockResolvedValue([]);

    const result = await service.analytics(vendorUser, {
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-31T23:59:59Z',
    });

    expect(result.avgOrderValue).toBe('0.00');
    expect(result.orderCount).toBe(0);
  });
});

describe('platform overview', () => {
  let prisma: {
    order: { findMany: ReturnType<typeof vi.fn> };
    vendor: { findMany: ReturnType<typeof vi.fn> };
    user: { count: ReturnType<typeof vi.fn> };
  };
  let service: VendorAnalyticsService;

  beforeEach(() => {
    prisma = {
      order: { findMany: vi.fn().mockResolvedValue([]) },
      vendor: { findMany: vi.fn().mockResolvedValue([]) },
      user: { count: vi.fn().mockResolvedValue(0) },
    };
    service = new VendorAnalyticsService(
      prisma as unknown as PrismaService,
      new CommissionService(),
    );
  });

  it('reports GMV including shipping and commission separately', async () => {
    prisma.order.findMany.mockResolvedValue([
      {
        grandTotal: dec('990.00'),
        commissionAmount: dec('90.00'),
        status: 'DELIVERED',
        vendorId: 'v1',
      },
    ]);
    prisma.user.count.mockResolvedValue(12);

    const result = await service.platformOverview({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-31T23:59:59Z',
    });

    expect(result.gmv).toBe('990.00');
    expect(result.commissionEarned).toBe('90.00');
    expect(result.orderCount).toBe(1);
    expect(result.newUsers).toBe(12);
  });

  it('excludes cancelled orders from GMV', async () => {
    prisma.order.findMany.mockResolvedValue([
      {
        grandTotal: dec('500.00'),
        commissionAmount: dec('50.00'),
        status: 'CANCELLED',
        vendorId: 'v1',
      },
    ]);

    const result = await service.platformOverview({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-31T23:59:59Z',
    });

    expect(result.gmv).toBe('0.00');
    expect(result.commissionEarned).toBe('0.00');
    expect(result.orderCount).toBe(0);
  });

  it('ignores commission on orders with no snapshot yet', async () => {
    prisma.order.findMany.mockResolvedValue([
      {
        grandTotal: dec('500.00'),
        commissionAmount: null,
        status: 'DELIVERED',
        vendorId: 'v1',
      },
    ]);

    const result = await service.platformOverview({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-31T23:59:59Z',
    });

    // GMV still counts; commission is zero because nothing was snapshotted.
    expect(result.gmv).toBe('500.00');
    expect(result.commissionEarned).toBe('0.00');
  });

  it('ranks the top ten vendors by earnings', async () => {
    prisma.vendor.findMany.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({
        id: `v${i}`,
        businessName: `Vendor ${i}`,
        slug: `vendor-${i}`,
        orders: [
          {
            grandTotal: dec(String((i + 1) * 1000)),
            vendorEarning: dec(String((i + 1) * 100)),
            commissionAmount: dec('0'),
          },
        ],
      })),
    );

    const result = await service.platformOverview({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-31T23:59:59Z',
    });

    expect(result.topVendors).toHaveLength(10);
    expect(result.topVendors[0]!.businessName).toBe('Vendor 11');
  });
});
