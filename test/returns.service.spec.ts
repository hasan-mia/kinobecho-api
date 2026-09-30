import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OrderStatus,
  PaymentGateway,
  PaymentStatus,
  Prisma,
  ReturnStatus,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '@prisma/client';
import { ReturnsService } from '../src/modules/returns/returns.service';
import { PrismaService } from '../src/database/prisma.service';
import { AuthenticatedUser } from '../src/common/guards/roles.guard';
import { ConfigService } from '@nestjs/config';

const dec = (v: string) => new Prisma.Decimal(v);

const DAY = 24 * 60 * 60 * 1000;

const buyer = {
  id: 'buyer-1',
  email: 'buyer@example.com',
  name: 'Buyer',
  role: UserRole.CUSTOMER,
  roleId: null,
} as unknown as AuthenticatedUser;

const admin = {
  id: 'admin-1',
  email: 'admin@example.com',
  name: 'Admin',
  role: UserRole.SUPER_ADMIN,
  roleId: null,
} as unknown as AuthenticatedUser;

const vendorUser = {
  id: 'vendor-user',
  email: 'vendor@example.com',
  name: 'Vendor',
  role: UserRole.VENDOR,
  roleId: null,
  vendor: { id: 'vendor-1', slug: 'v', businessName: 'V', status: 'ACTIVE' },
} as unknown as AuthenticatedUser;

const orderItem = {
  id: 'oi-1',
  orderId: 'order-1',
  productVariantId: 'pv-1',
  productNameSnap: 'Widget',
  qty: 3,
  unitPrice: dec('100'),
  lineTotal: dec('300'),
};

const order = {
  id: 'order-1',
  orderNumber: 'KB-1',
  status: OrderStatus.DELIVERED,
  paymentStatus: PaymentStatus.PAID,
  paymentMethod: PaymentGateway.STRIPE,
  subtotal: dec('300'),
  discountTotal: dec('0'),
  shippingFee: dec('60'),
  grandTotal: dec('360'),
  buyerId: 'buyer-1',
  vendorId: 'vendor-1',
  vendorEarning: dec('270'),
};

const returnRequest = (overrides: Record<string, unknown> = {}) => ({
  id: 'ret-1',
  orderId: 'order-1',
  buyerId: 'buyer-1',
  vendorId: 'vendor-1',
  status: ReturnStatus.RECEIVED,
  reason: 'DAMAGED',
  items: [{ id: 'ri-1', orderItemId: 'oi-1', qty: 1 }],
  order: {
    id: 'order-1',
    orderNumber: 'KB-1',
    status: OrderStatus.DELIVERED,
    paymentStatus: PaymentStatus.PAID,
    paymentMethod: PaymentGateway.STRIPE,
    subtotal: dec('300'),
    discountTotal: dec('0'),
    shippingFee: dec('60'),
    grandTotal: dec('360'),
    buyerId: 'buyer-1',
    vendorId: 'vendor-1',
  },
  buyer: { id: 'buyer-1', name: 'Buyer', email: 'buyer@example.com' },
  vendor: { id: 'vendor-1', businessName: 'V', userId: 'vendor-user' },
  decidedBy: null,
  refundAmount: null,
  ...overrides,
});

describe('ReturnsService.create — window and quantity limits', () => {
  let prisma: any;
  let service: ReturnsService;
  let notifications: { sendTransactionalEmail: ReturnType<typeof vi.fn> };
  let deliveredDaysAgo: number;

  beforeEach(() => {
    deliveredDaysAgo = 2;
    prisma = {
      order: {
        findUnique: vi.fn().mockResolvedValue({ ...order, items: [orderItem] }),
      },
      orderStatusHistory: {
        findFirst: vi.fn().mockImplementation(() =>
          Promise.resolve({
            createdAt: new Date(Date.now() - deliveredDaysAgo * DAY),
          }),
        ),
      },
      returnItem: { findMany: vi.fn().mockResolvedValue([]) },
      returnRequest: { create: vi.fn().mockResolvedValue(returnRequest()) },
      user: { findUnique: vi.fn().mockResolvedValue({ email: 'v@example.com' }) },
    };

    notifications = { sendTransactionalEmail: vi.fn().mockResolvedValue({}) };

    service = new ReturnsService(
      prisma as unknown as PrismaService,
      { get: () => 7 } as unknown as ConfigService,
      notifications as never,
      {} as never,
      { moveToSystem: vi.fn() } as never,
    );
  });

  const dto = (qty = 1) => ({
    orderId: 'order-1',
    reason: 'DAMAGED' as never,
    items: [{ orderItemId: 'oi-1', qty }],
  });

  it('accepts a return inside the window', async () => {
    await service.create(buyer, dto());

    expect(prisma.returnRequest.create).toHaveBeenCalledTimes(1);
    expect(prisma.returnRequest.create.mock.calls[0][0].data.status).toBe(
      ReturnStatus.REQUESTED,
    );
  });

  it('refuses a non-DELIVERED order', async () => {
    prisma.order.findUnique.mockResolvedValue({
      ...order,
      status: OrderStatus.SHIPPED,
      items: [orderItem],
    });

    await expect(service.create(buyer, dto())).rejects.toThrow(/delivered/i);
    expect(prisma.returnRequest.create).not.toHaveBeenCalled();
  });

  it('refuses a return filed after the window closes', async () => {
    deliveredDaysAgo = 8;

    await expect(service.create(buyer, dto())).rejects.toThrow(
      /7-day return window/,
    );
    expect(prisma.returnRequest.create).not.toHaveBeenCalled();
  });

  it('measures the window from the delivery event, not from order.updatedAt', async () => {
    deliveredDaysAgo = 7;

    // Exactly on the boundary is still inside the window.
    await expect(service.create(buyer, dto())).resolves.toBeDefined();
    expect(prisma.orderStatusHistory.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: 'order-1', toStatus: OrderStatus.DELIVERED },
      }),
    );
  });

  it('refuses a return with no delivery record at all', async () => {
    prisma.orderStatusHistory.findFirst.mockResolvedValue(null);

    await expect(service.create(buyer, dto())).rejects.toThrow(
      /no delivery record/i,
    );
  });

  it('refuses quantities above what was purchased', async () => {
    await expect(service.create(buyer, dto(4))).rejects.toThrow(
      /can still be returned/,
    );
  });

  it('counts what another live return has already reserved', async () => {
    prisma.returnItem.findMany.mockResolvedValue([
      { orderItemId: 'oi-1', qty: 2 },
    ]);

    await expect(service.create(buyer, dto(2))).rejects.toThrow(
      /Only 1 of "Widget"/,
    );
    await expect(service.create(buyer, dto(1))).resolves.toBeDefined();
  });

  it('sums duplicate lines for the same order item before checking', async () => {
    // Two entries of 2 each would each pass a naive per-entry check against the
    // purchased 3, but together they exceed it.
    await expect(
      service.create(buyer, {
        orderId: 'order-1',
        reason: 'DAMAGED' as never,
        items: [
          { orderItemId: 'oi-1', qty: 2 },
          { orderItemId: 'oi-1', qty: 2 },
        ],
      }),
    ).rejects.toThrow(/can still be returned/);
  });

  it('rejects an order item from a different order', async () => {
    await expect(
      service.create(buyer, {
        orderId: 'order-1',
        reason: 'DAMAGED' as never,
        items: [{ orderItemId: 'oi-other', qty: 1 }],
      }),
    ).rejects.toThrow(/does not belong to this order/);
  });

  it('refuses to return someone else\'s order', async () => {
    prisma.order.findUnique.mockResolvedValue({
      ...order,
      buyerId: 'someone-else',
      items: [orderItem],
    });

    await expect(service.create(buyer, dto())).rejects.toThrow(
      /your own orders/i,
    );
  });

  it('notifies the buyer and the vendor', async () => {
    await service.create(buyer, dto());

    const templates = notifications.sendTransactionalEmail.mock.calls.map(
      (call) => call[3],
    );

    expect(templates).toEqual(
      expect.arrayContaining(['return-requested', 'vendor-return-decision']),
    );
  });
});

describe('ReturnsService.refund — money and vendor adjustment', () => {
  let prisma: any;
  let service: ReturnsService;
  let payments: { refundWithGateway: ReturnType<typeof vi.fn> };
  let orderStatus: { moveToSystem: ReturnType<typeof vi.fn> };
  let tx: any;

  const build = (opts: {
    gateway: PaymentGateway | null;
    payoutCoversOrder: boolean;
    request?: Record<string, unknown>;
    orderRow?: Record<string, unknown>;
  }) => {
    prisma = {
      returnRequest: {
        findUnique: vi.fn().mockResolvedValue(returnRequest(opts.request)),
        update: vi.fn().mockResolvedValue(returnRequest()),
      },
      order: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(opts.orderRow ?? order),
        update: vi.fn().mockResolvedValue({}),
      },
      transaction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'pay-1',
          amount: dec('360'),
          currency: 'BDT',
          gateway: opts.gateway,
          externalRef: opts.gateway ? 'ext-1' : null,
        }),
        aggregate: vi.fn().mockResolvedValue({ _sum: { amount: dec('0') } }),
        create: vi.fn().mockResolvedValue({ id: 'adj-1' }),
      },
      transactionOrder: {
        findFirst: vi
          .fn()
          .mockResolvedValue(opts.payoutCoversOrder ? { transactionId: 'po-1' } : null),
      },
      orderItem: { findMany: vi.fn().mockResolvedValue([orderItem]) },
      returnItem: { findMany: vi.fn().mockResolvedValue([]) },
      user: { findUnique: vi.fn().mockResolvedValue({ email: 'v@example.com' }) },
    };

    tx = {
      transaction: {
        create: vi.fn().mockResolvedValue({ id: 'txn-refund-1' }),
        aggregate: vi.fn().mockResolvedValue({ _sum: { amount: dec('100') } }),
      },
      order: { update: vi.fn().mockResolvedValue({}) },
      returnRequest: { update: vi.fn().mockResolvedValue({}) },
    };

    prisma.$transaction = vi.fn((fn: (client: any) => unknown) => fn(tx));

    payments = { refundWithGateway: vi.fn().mockResolvedValue('gw-refund-1') };
    orderStatus = { moveToSystem: vi.fn().mockResolvedValue({}) };

    service = new ReturnsService(
      prisma as unknown as PrismaService,
      { get: () => 7 } as unknown as ConfigService,
      { sendTransactionalEmail: vi.fn().mockResolvedValue({}) } as never,
      payments as never,
      orderStatus as never,
    );
  };

  it('calls the gateway and books a COMPLETED refund for an online payment', async () => {
    build({ gateway: PaymentGateway.STRIPE, payoutCoversOrder: false });

    const result = await service.refund(admin, 'ret-1', {});

    expect(payments.refundWithGateway).toHaveBeenCalledWith(
      PaymentGateway.STRIPE,
      'ext-1',
      dec('100'),
    );
    expect(tx.transaction.create.mock.calls[0][0].data.status).toBe(
      TransactionStatus.COMPLETED,
    );
    expect(result.awaitingManualPayout).toBe(false);
    expect(result.refundAmount).toBe('100.00');
  });

  it('leaves a COD refund PENDING for a manual payout and never calls a gateway', async () => {
    build({
      gateway: PaymentGateway.COD,
      payoutCoversOrder: false,
      orderRow: { ...order, paymentMethod: PaymentGateway.COD },
    });

    const result = await service.refund(admin, 'ret-1', {});

    expect(payments.refundWithGateway).not.toHaveBeenCalled();
    expect(tx.transaction.create.mock.calls[0][0].data.status).toBe(
      TransactionStatus.PENDING,
    );
    expect(tx.transaction.create.mock.calls[0][0].data.completedAt).toBeNull();
    expect(result.awaitingManualPayout).toBe(true);
  });

  it('marks the order partially refunded until the whole payment is returned', async () => {
    build({ gateway: PaymentGateway.STRIPE, payoutCoversOrder: false });

    await service.refund(admin, 'ret-1', {});

    expect(tx.order.update.mock.calls[0][0].data.paymentStatus).toBe(
      PaymentStatus.PARTIALLY_REFUNDED,
    );
  });

  it('books a negative vendor ADJUSTMENT when a payout already covers the order', async () => {
    build({ gateway: PaymentGateway.STRIPE, payoutCoversOrder: true });

    const result = await service.refund(admin, 'ret-1', {});

    const adjustment = prisma.transaction.create.mock.calls[0][0].data;

    expect(adjustment.type).toBe(TransactionType.ADJUSTMENT);
    expect(adjustment.fromType).toBe('VENDOR');
    expect(adjustment.toType).toBe('PLATFORM');
    expect(adjustment.vendorId).toBe('vendor-1');
    expect(result.vendorAdjustment).not.toBeNull();
  });

  it('books no adjustment when no payout covers the order', async () => {
    build({ gateway: PaymentGateway.STRIPE, payoutCoversOrder: false });

    const result = await service.refund(admin, 'ret-1', {});

    // The vendor's available balance falls on its own; a ledger row here would
    // deduct the same money twice.
    expect(prisma.transaction.create).not.toHaveBeenCalled();
    expect(result.vendorAdjustment).toBeNull();
  });

  it('caps the refund at what the order still owes the buyer', async () => {
    build({ gateway: PaymentGateway.STRIPE, payoutCoversOrder: false });
    prisma.transaction.aggregate.mockResolvedValue({ _sum: { amount: dec('300') } });

    const result = await service.refund(admin, 'ret-1', {});

    expect(result.refundAmount).toBe('60.00');
    expect(result.breakdown.cappedByRemainingRefundable).toBe(true);
  });

  it('refuses to refund a return that has not been received', async () => {
    build({
      gateway: PaymentGateway.STRIPE,
      payoutCoversOrder: false,
      request: { status: ReturnStatus.APPROVED },
    });

    await expect(service.refund(admin, 'ret-1', {})).rejects.toThrow(
      /must be RECEIVED/,
    );
  });

  it('refuses to refund twice', async () => {
    build({
      gateway: PaymentGateway.STRIPE,
      payoutCoversOrder: false,
      request: { status: ReturnStatus.REFUNDED },
    });

    await expect(service.refund(admin, 'ret-1', {})).rejects.toThrow(
      /already been refunded/,
    );
  });

  it('refuses when the order has nothing left to refund', async () => {
    build({ gateway: PaymentGateway.STRIPE, payoutCoversOrder: false });
    prisma.transaction.aggregate.mockResolvedValue({ _sum: { amount: dec('360') } });

    await expect(service.refund(admin, 'ret-1', {})).rejects.toThrow(
      /already been fully refunded/,
    );
  });

  it('only moves the order to RETURNED once every unit is back', async () => {
    build({ gateway: PaymentGateway.STRIPE, payoutCoversOrder: false });
    // Two of three units returned.
    prisma.returnItem.findMany.mockResolvedValue([
      { orderItemId: 'oi-1', qty: 2 },
    ]);

    await service.refund(admin, 'ret-1', {});

    expect(orderStatus.moveToSystem).not.toHaveBeenCalled();
  });

  it('moves a fully returned order to RETURNED', async () => {
    build({ gateway: PaymentGateway.STRIPE, payoutCoversOrder: false });
    prisma.returnItem.findMany.mockResolvedValue([
      { orderItemId: 'oi-1', qty: 3 },
    ]);

    await service.refund(admin, 'ret-1', {});

    expect(orderStatus.moveToSystem).toHaveBeenCalledWith(
      undefined,
      'order-1',
      OrderStatus.RETURNED,
      expect.objectContaining({ actorId: 'admin-1' }),
    );
  });
});

describe('ReturnsService.decide and receive', () => {
  let prisma: any;
  let service: ReturnsService;
  let tx: any;

  beforeEach(() => {
    prisma = {
      returnRequest: {
        findUnique: vi.fn().mockResolvedValue(returnRequest({ status: ReturnStatus.REQUESTED })),
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue(returnRequest({ status: ReturnStatus.RECEIVED })),
        update: vi.fn().mockResolvedValue(returnRequest({ status: ReturnStatus.APPROVED })),
      },
      productVariant: { update: vi.fn().mockResolvedValue({}) },
      orderItem: { findMany: vi.fn().mockResolvedValue([orderItem]) },
      user: { findUnique: vi.fn().mockResolvedValue({ email: 'v@example.com' }) },
    };

    tx = {
      returnRequest: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'ret-1',
          status: ReturnStatus.APPROVED,
          items: [{ id: 'ri-1', orderItemId: 'oi-1', qty: 2 }],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      orderItem: { findMany: vi.fn().mockResolvedValue([orderItem]) },
      productVariant: { update: vi.fn().mockResolvedValue({}) },
    };

    prisma.$transaction = vi.fn((fn: (client: any) => unknown) => fn(tx));

    service = new ReturnsService(
      prisma as unknown as PrismaService,
      { get: () => 7 } as unknown as ConfigService,
      { sendTransactionalEmail: vi.fn().mockResolvedValue({}) } as never,
      {} as never,
      {} as never,
    );
  });

  it('requires a note when rejecting', async () => {
    await expect(
      service.decide(vendorUser, 'ret-1', { decision: 'REJECTED' }),
    ).rejects.toThrow(/note is required/);
  });

  it('refuses a decision from a vendor who did not sell the order', async () => {
    const other = { ...vendorUser, vendor: { id: 'vendor-2' } } as unknown as AuthenticatedUser;

    await expect(
      service.decide(other, 'ret-1', { decision: 'APPROVED' }),
    ).rejects.toThrow(/only the vendor who sold this order/i);
  });

  it('approves and records the decision maker', async () => {
    await service.decide(vendorUser, 'ret-1', { decision: 'APPROVED' });

    const data = prisma.returnRequest.update.mock.calls[0][0].data;
    expect(data.status).toBe(ReturnStatus.APPROVED);
    expect(data.decidedById).toBe('vendor-user');
  });

  it('restocks the returned units', async () => {
    await service.receive(vendorUser, 'ret-1', {});

    expect(tx.productVariant.update).toHaveBeenCalledWith({
      where: { id: 'pv-1' },
      data: { stock: { increment: 2 } },
    });
  });

  it('skips restocking when asked to', async () => {
    await service.receive(vendorUser, 'ret-1', { restock: false });

    expect(tx.productVariant.update).not.toHaveBeenCalled();
  });

  it('does not restock twice if the return is already received', async () => {
    tx.returnRequest.findUnique.mockResolvedValue({
      id: 'ret-1',
      status: ReturnStatus.RECEIVED,
      items: [{ id: 'ri-1', orderItemId: 'oi-1', qty: 2 }],
    });

    await service.receive(vendorUser, 'ret-1', {});

    expect(tx.productVariant.update).not.toHaveBeenCalled();
  });
});
