import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  OrderStatus,
  PaymentGateway,
  PaymentStatus,
  Prisma,
  TransactionStatus,
} from '@prisma/client';
import { OrderCancellationService } from '../src/modules/orders/order-cancellation.service';
import { OrderExpiryProcessor } from '../src/processors/order-expiry.processor';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { PrismaService } from '../src/database/prisma.service';
import { ConfigService } from '@nestjs/config';

/**
 * Unpaid-order expiry: the sweep, the cancellation side effects, idempotency, and
 * the late-webhook refund. Prisma is mocked and `$transaction` simply invokes its
 * callback with the same stub, which keeps the "single transaction" contract
 * observable without a database.
 */
describe('order expiry and cancellation', () => {
  let prisma: {
    order: {
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    orderItem: { groupBy: ReturnType<typeof vi.fn> };
    coupon: { updateMany: ReturnType<typeof vi.fn> };
    transaction: {
      create: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    orderStatusHistory: { create: ReturnType<typeof vi.fn> };
    productVariant: { update: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let cancellation: OrderCancellationService;

  const buildOrder = (overrides: Record<string, unknown> = {}) => ({
    id: 'order-1',
    orderNumber: 'ORD-1',
    buyerId: 'buyer-1',
    vendorId: 'vendor-1',
    status: OrderStatus.PENDING,
    paymentMethod: null,
    paymentStatus: PaymentStatus.UNPAID,
    couponId: null as string | null,
    discountTotal: new Prisma.Decimal(0),
    ...overrides,
  });

  beforeEach(() => {
    prisma = {
      order: {
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      orderItem: { groupBy: vi.fn() },
      coupon: { updateMany: vi.fn() },
      transaction: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
      },
      orderStatusHistory: { create: vi.fn() },
      productVariant: { update: vi.fn() },
      $transaction: vi.fn(),
    };

    prisma.$transaction.mockImplementation(
      (cb: (tx: unknown) => unknown) => cb(prisma),
    );
    prisma.orderItem.groupBy.mockResolvedValue([]);
    prisma.coupon.updateMany.mockResolvedValue({ count: 0 });
    prisma.transaction.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.update.mockResolvedValue({});
    prisma.orderStatusHistory.create.mockResolvedValue({});
    prisma.productVariant.update.mockResolvedValue({});

    cancellation = new OrderCancellationService(prisma as unknown as PrismaService);
  });

  const buildProcessor = () =>
    new OrderExpiryProcessor(
      prisma as unknown as PrismaService,
      cancellation,
      { upsertJobScheduler: vi.fn() } as never,
    );

  describe('OrderCancellationService', () => {
    it('restocks every order item, fails the open payment and records history', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder());
      prisma.orderItem.groupBy.mockResolvedValue([
        { productVariantId: 'variant-a', _sum: { qty: 3 } },
        { productVariantId: 'variant-b', _sum: { qty: 1 } },
      ]);

      const result = await cancellation.cancelOrder('order-1', 'admin-1', 'Expired');

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: { status: OrderStatus.CANCELLED, expiresAt: null },
      });

      expect(prisma.productVariant.update).toHaveBeenCalledWith({
        where: { id: 'variant-a' },
        data: { stock: { increment: 3 } },
      });
      expect(prisma.productVariant.update).toHaveBeenCalledWith({
        where: { id: 'variant-b' },
        data: { stock: { increment: 1 } },
      });

      // The ledger must never keep a PENDING payment against a cancelled order.
      expect(prisma.transaction.updateMany).toHaveBeenCalledWith({
        where: { orderId: 'order-1', status: TransactionStatus.PENDING },
        data: { status: TransactionStatus.FAILED },
      });

      expect(prisma.orderStatusHistory.create).toHaveBeenCalledWith({
        data: {
          orderId: 'order-1',
          fromStatus: OrderStatus.PENDING,
          toStatus: OrderStatus.CANCELLED,
          note: 'Expired',
          changedById: 'admin-1',
        },
      });

      expect(result).toMatchObject({
        orderId: 'order-1',
        cancelled: true,
        transactionsFailed: 1,
      });
    });

    it('releases the coupon only when a discount was actually applied', async () => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({
          couponId: 'coupon-1',
          discountTotal: new Prisma.Decimal('250.00'),
        }),
      );
      prisma.coupon.updateMany.mockResolvedValue({ count: 1 });

      const result = await cancellation.cancelOrder('order-1', null);

      expect(prisma.coupon.updateMany).toHaveBeenCalledWith({
        where: { id: 'coupon-1', usedCount: { gt: 0 } },
        data: { usedCount: { decrement: 1 } },
      });
      expect(result.couponReleased).toBe(true);
    });

    it('leaves the coupon counter alone for a full-price order', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder({ couponId: 'coupon-1' }));

      const result = await cancellation.cancelOrder('order-1', null);

      expect(prisma.coupon.updateMany).not.toHaveBeenCalled();
      expect(result.couponReleased).toBe(false);
    });

    it('is idempotent: a repeat cancel writes nothing and does not restock twice', async () => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ status: OrderStatus.CANCELLED }),
      );

      const result = await cancellation.cancelOrder('order-1', null);

      expect(result.cancelled).toBe(false);
      expect(prisma.productVariant.update).not.toHaveBeenCalled();
      expect(prisma.coupon.updateMany).not.toHaveBeenCalled();
      expect(prisma.transaction.updateMany).not.toHaveBeenCalled();
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(prisma.orderStatusHistory.create).not.toHaveBeenCalled();
    });

    it('rejects a cancel that is not a legal transition', async () => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ status: OrderStatus.SHIPPED }),
      );

      await expect(cancellation.cancelOrder('order-1', null)).rejects.toThrow(
        /Cannot cancel order from status SHIPPED/,
      );
      expect(prisma.order.update).not.toHaveBeenCalled();
    });
  });

  describe('OrderExpiryProcessor', () => {
    it('selects only PENDING/UNPAID orders that are past their deadline', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      const processor = buildProcessor();

      await processor.process({} as never);

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: OrderStatus.PENDING,
            paymentStatus: PaymentStatus.UNPAID,
            expiresAt: { lt: expect.any(Date) },
          },
          take: 100,
        }),
      );
    });

    it('cancels a due order through the shared cancellation service', async () => {
      prisma.order.findMany.mockResolvedValue([{ id: 'order-1' }]);
      prisma.order.findUnique.mockResolvedValue(buildOrder());
      const cancelSpy = vi
        .spyOn(cancellation, 'cancelOrder')
        .mockResolvedValue({
          orderId: 'order-1',
          cancelled: true,
          restocked: [],
          couponReleased: false,
          transactionsFailed: 0,
          flashSaleReleased: [],
        });

      const result = await buildProcessor().process({} as never);

      expect(cancelSpy).toHaveBeenCalledWith(
        'order-1',
        null,
        expect.any(String),
        // Precondition re-asserted so a concurrent payment webhook wins.
        { requireStatus: OrderStatus.PENDING },
      );
      expect(result).toEqual({ scanned: 1, cancelled: 1 });
    });

    it('skips COD orders because their paymentStatus is not UNPAID', async () => {
      // PENDING_COD with a stale deadline must not be selected; the query filter
      // is what guarantees this rather than a check in JS.
      prisma.order.findMany.mockResolvedValue([]);
      const processor = buildProcessor();

      const result = await processor.process({} as never);

      expect(result).toEqual({ scanned: 0, cancelled: 0 });
      const call = prisma.order.findMany.mock.calls[0] as unknown as [
        { where: { paymentStatus: PaymentStatus } },
      ];
      expect(call[0].where.paymentStatus).toBe(PaymentStatus.UNPAID);
    });

    it('keeps sweeping after one order fails to cancel', async () => {
      prisma.order.findMany.mockResolvedValue([{ id: 'bad' }, { id: 'good' }]);
      vi.spyOn(cancellation, 'cancelOrder')
        .mockRejectedValueOnce(new Error('deadlock detected'))
        .mockResolvedValueOnce({
          orderId: 'good',
          cancelled: true,
          restocked: [],
          couponReleased: false,
          transactionsFailed: 0,
          flashSaleReleased: [],
        });

      const result = await buildProcessor().process({} as never);

      expect(result).toEqual({ scanned: 2, cancelled: 1 });
    });

    it('does not double-cancel when a payment webhook won the race', async () => {
      // The webhook committed first, so the order is no longer PENDING. The
      // in-transaction re-read must make the cancellation a no-op.
      prisma.order.findMany.mockResolvedValue([{ id: 'order-1' }]);
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ status: OrderStatus.CONFIRMED }),
      );

      const result = await buildProcessor().process({} as never);

      expect(result).toEqual({ scanned: 1, cancelled: 0 });
      expect(prisma.order.update).not.toHaveBeenCalled();
    });
  });

  describe('payment webhook arriving after cancellation', () => {
    let payments: PaymentsService;
    let logger: { warn: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      logger = { warn: vi.fn(), log: vi.fn() };
      payments = new PaymentsService(
        prisma as unknown as PrismaService,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { get: vi.fn() } as unknown as ConfigService,
      );
      // Spy on the instance logger without reimplementing the service.
      (payments as unknown as { logger: typeof logger }).logger = logger;
    });

    it('keeps the payment COMPLETED and raises a PENDING refund instead of reviving the order', async () => {
      prisma.transaction.findUnique.mockImplementation(
        (args: { where: { externalRef: string } }) =>
          Promise.resolve(
            args.where.externalRef === 'auto-refund:pay-1' ? null : {
              id: 'pay-1',
              orderId: 'order-1',
              amount: new Prisma.Decimal('1500.00'),
              currency: 'BDT',
              gateway: PaymentGateway.BKASH,
              status: TransactionStatus.PENDING,
            },
          ),
      );
      prisma.transaction.update.mockResolvedValue({ id: 'pay-1' });
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ status: OrderStatus.CANCELLED }),
      );

      await payments.confirmPayment({
        externalRef: 'bkash-abc',
        gateway: PaymentGateway.BKASH,
        amount: new Prisma.Decimal('1500.00'),
        rawResponse: {},
      } as never);

      // The money arrived; the ledger must say so.
      expect(prisma.transaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pay-1' },
          data: expect.objectContaining({
            status: TransactionStatus.COMPLETED,
          }),
        }),
      );

      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'REFUND',
          status: TransactionStatus.PENDING,
          direction: 'DEBIT',
          fromType: 'PLATFORM',
          toType: 'CUSTOMER',
          toId: 'buyer-1',
          orderId: 'order-1',
          externalRef: 'auto-refund:pay-1',
        }),
      });

      // The cancelled order is not touched: no PAID flip, no status revival.
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('does not raise a second refund when the gateway redelivers', async () => {
      prisma.transaction.findUnique.mockImplementation(
        (args: { where: { externalRef: string } }) =>
          Promise.resolve(
            args.where.externalRef === 'auto-refund:pay-1'
              ? { id: 'refund-1', externalRef: 'auto-refund:pay-1' }
              : {
                  id: 'pay-1',
                  orderId: 'order-1',
                  amount: new Prisma.Decimal('1500.00'),
                  currency: 'BDT',
                  gateway: PaymentGateway.BKASH,
                  status: TransactionStatus.PENDING,
                },
          ),
      );
      prisma.transaction.update.mockResolvedValue({ id: 'pay-1' });
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ status: OrderStatus.CANCELLED }),
      );

      await payments.confirmPayment({
        externalRef: 'bkash-abc',
        gateway: PaymentGateway.BKASH,
        amount: new Prisma.Decimal('1500.00'),
        rawResponse: {},
      } as never);

      expect(prisma.transaction.create).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    });
  });
});
