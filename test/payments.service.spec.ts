import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  OrderStatus,
  PaymentGateway,
  PaymentStatus,
  Prisma,
  TransactionStatus,
  UserRole,
} from '@prisma/client';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { PrismaService } from '../src/database/prisma.service';
import { AuthenticatedUser } from '../src/common/guards/roles.guard';
import { ConfigService } from '@nestjs/config';

/**
 * Unit tests for cash-on-delivery.
 * PrismaService and ConfigService are mocked; no database or network involved.
 */
describe('PaymentsService cash on delivery', () => {
  let prisma: {
    order: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    transaction: {
      create: ReturnType<typeof vi.fn>;
      updateMany: ReturnType<typeof vi.fn>;
    };
    orderStatusHistory: { create: ReturnType<typeof vi.fn> };
    $transaction: ReturnType<typeof vi.fn>;
  };
  let codEnabled: boolean;
  let codMaxAmount: number;
  let service: PaymentsService;

  const buyer = (
    overrides: Partial<AuthenticatedUser> = {},
  ): AuthenticatedUser => ({
    id: 'buyer-1',
    email: 'buyer@kinobecho.dev',
    name: 'Buyer',
    role: UserRole.CUSTOMER,
    roleId: null,
    vendor: null,
    ...overrides,
  });

  const buildOrder = (overrides: Record<string, unknown> = {}) => ({
    id: 'order-1',
    orderNumber: 'ORD-1',
    buyerId: 'buyer-1',
    vendorId: 'vendor-1',
    status: OrderStatus.PENDING,
    grandTotal: new Prisma.Decimal('1500.00'),
    paymentMethod: null,
    paymentStatus: PaymentStatus.UNPAID,
    ...overrides,
  });

  const createdTransaction = {
    id: 'tx-1',
    type: 'PAYMENT',
    direction: 'CREDIT',
    status: TransactionStatus.PENDING,
    amount: new Prisma.Decimal('1500.00'),
    gateway: PaymentGateway.COD,
    externalRef: 'cod:order-1',
    orderId: 'order-1',
  };

  beforeEach(() => {
    codEnabled = true;
    codMaxAmount = 20000;

    prisma = {
      order: { findUnique: vi.fn(), update: vi.fn() },
      transaction: { create: vi.fn(), updateMany: vi.fn() },
      orderStatusHistory: { create: vi.fn() },
      $transaction: vi.fn(),
    };

    prisma.$transaction.mockImplementation(
      (cb: (tx: unknown) => unknown) => cb(prisma),
    );
    prisma.transaction.create.mockResolvedValue(createdTransaction);
    prisma.order.update.mockResolvedValue({});
    prisma.orderStatusHistory.create.mockResolvedValue({});

    const config = {
      get: (key: string) => {
        if (key === 'cod.enabled') return codEnabled;
        if (key === 'cod.maxAmount') return codMaxAmount;
        return undefined;
      },
    } as unknown as ConfigService;

    service = new PaymentsService(
      prisma as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      config,
    );
  });

  describe('createCodPaymentForOrder', () => {
    it('creates a pending COD ledger row and confirms the order', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder());

      await service.createCodPaymentForOrder(buyer(), 'order-1');

      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: 'PAYMENT',
          direction: 'CREDIT',
          status: TransactionStatus.PENDING,
          gateway: PaymentGateway.COD,
          fromType: 'CUSTOMER',
          toType: 'PLATFORM',
          orderId: 'order-1',
        }),
      });

      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: {
          paymentMethod: PaymentGateway.COD,
          paymentStatus: PaymentStatus.PENDING_COD,
          status: OrderStatus.CONFIRMED,
        },
      });

      expect(prisma.orderStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orderId: 'order-1',
          fromStatus: OrderStatus.PENDING,
          toStatus: OrderStatus.CONFIRMED,
        }),
      });
    });

    it('never calls an online gateway provider', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder());
      const createIntent = vi.fn();

      await service.createCodPaymentForOrder(buyer(), 'order-1');

      expect(createIntent).not.toHaveBeenCalled();
      expect(prisma.transaction.create).toHaveBeenCalledTimes(1);
    });

    it('rejects an order above COD_MAX_AMOUNT', async () => {
      codMaxAmount = 20000;
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ grandTotal: new Prisma.Decimal('25000.00') }),
      );

      await expect(
        service.createCodPaymentForOrder(buyer(), 'order-1'),
      ).rejects.toThrow('Cash on delivery is not available for orders above 20000');

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('accepts an order exactly at COD_MAX_AMOUNT', async () => {
      codMaxAmount = 20000;
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ grandTotal: new Prisma.Decimal('20000.00') }),
      );

      await service.createCodPaymentForOrder(buyer(), 'order-1');

      expect(prisma.transaction.create).toHaveBeenCalledTimes(1);
    });

    it('rejects when the caller is not the buyer', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder());

      await expect(
        service.createCodPaymentForOrder(buyer({ id: 'someone-else' }), 'order-1'),
      ).rejects.toThrow('Only the buyer can select cash on delivery');

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects when the order is not PENDING', async () => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ status: OrderStatus.SHIPPED }),
      );

      await expect(
        service.createCodPaymentForOrder(buyer(), 'order-1'),
      ).rejects.toThrow(
        'Cash on delivery can only be selected for a pending order',
      );
    });

    it('rejects when COD is disabled', async () => {
      codEnabled = false;
      prisma.order.findUnique.mockResolvedValue(buildOrder());

      await expect(
        service.createCodPaymentForOrder(buyer(), 'order-1'),
      ).rejects.toThrow('Cash on delivery is not available');
    });

    it('rejects a second COD selection on the same order', async () => {
      prisma.order.findUnique.mockResolvedValue(
        buildOrder({ paymentMethod: PaymentGateway.COD }),
      );

      await expect(
        service.createCodPaymentForOrder(buyer(), 'order-1'),
      ).rejects.toThrow('Cash on delivery is already selected');
    });

    it('routes gateway=COD through createPaymentForOrder', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrder());

      await service.createPaymentForOrder(
        buyer(),
        'order-1',
        PaymentGateway.COD,
      );

      expect(prisma.transaction.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ gateway: PaymentGateway.COD }),
      });
    });
  });

  describe('settleCodOnDelivery', () => {
    it('completes the COD row and marks the order PAID', async () => {
      prisma.transaction.updateMany.mockResolvedValue({ count: 1 });

      const settled = await service.settleCodOnDelivery(
        prisma as never,
        {
          id: 'order-1',
          paymentMethod: PaymentGateway.COD,
          paymentStatus: PaymentStatus.PENDING_COD,
        },
      );

      expect(settled).toBe(true);
      expect(prisma.transaction.updateMany).toHaveBeenCalledWith({
        where: {
          orderId: 'order-1',
          type: 'PAYMENT',
          gateway: PaymentGateway.COD,
          status: TransactionStatus.PENDING,
        },
        data: {
          status: TransactionStatus.COMPLETED,
          completedAt: expect.any(Date),
        },
      });
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: { paymentStatus: PaymentStatus.PAID },
      });
    });

    it('ignores non-COD orders', async () => {
      const settled = await service.settleCodOnDelivery(prisma as never, {
        id: 'order-1',
        paymentMethod: PaymentGateway.STRIPE,
        paymentStatus: PaymentStatus.PAID,
      });

      expect(settled).toBe(false);
      expect(prisma.transaction.updateMany).not.toHaveBeenCalled();
      expect(prisma.order.update).not.toHaveBeenCalled();
    });

    it('is idempotent when the COD payment is already collected', async () => {
      const settled = await service.settleCodOnDelivery(prisma as never, {
        id: 'order-1',
        paymentMethod: PaymentGateway.COD,
        paymentStatus: PaymentStatus.PAID,
      });

      expect(settled).toBe(false);
      expect(prisma.transaction.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('getEnabledMethods', () => {
    it('includes COD when enabled', () => {
      const result = service.getEnabledMethods();

      expect(result.cod).toEqual({ enabled: true, maxAmount: 20000 });
      expect(result.methods).toContainEqual({
        code: PaymentGateway.COD,
        label: 'Cash on delivery',
        maxAmount: 20000,
      });
    });

    it('omits COD when disabled', () => {
      codEnabled = false;

      const result = service.getEnabledMethods();

      expect(result.cod.enabled).toBe(false);
      expect(
        result.methods.map((m) => m.code),
      ).not.toContain(PaymentGateway.COD);
    });
  });
});