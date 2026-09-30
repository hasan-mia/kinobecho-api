import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OrderStatus,
  PaymentGateway,
  PaymentStatus,
  Prisma,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { PrismaService } from '../src/database/prisma.service';
import { AuthenticatedUser } from '../src/common/guards/roles.guard';

const dec = (v: string) => new Prisma.Decimal(v);

const admin = {
  id: 'admin-1',
  email: 'admin@example.com',
  name: 'Admin',
  role: UserRole.SUPER_ADMIN,
  roleId: null,
  vendor: null,
} as unknown as AuthenticatedUser;

const provider = { refundPayment: vi.fn() };

/**
 * A refund created for a COD order is born PENDING: no gateway moved money, so
 * the row is an instruction to pay the buyer by hand. These tests pin the two
 * things that must follow from that — nothing reaches a gateway, and the order
 * only reads as refunded once an operator confirms the payout.
 */
describe('PaymentsService.refundWithGateway and confirmRefund', () => {
  let prisma: any;
  let service: PaymentsService;
  let tx: any;

  beforeEach(() => {
    provider.refundPayment.mockReset();
    provider.refundPayment.mockResolvedValue({ id: 'gw-refund-1' });

    prisma = {
      transaction: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
      order: { findUnique: vi.fn() },
    };

    tx = {
      transaction: {
        update: vi.fn().mockResolvedValue({ id: 'txn-1' }),
        aggregate: vi.fn().mockResolvedValue({ _sum: { amount: dec('1000') } }),
      },
      order: {
        findUnique: vi.fn().mockResolvedValue({ status: OrderStatus.DELIVERED }),
        update: vi.fn().mockResolvedValue({ id: 'order-1' }),
      },
      orderStatusHistory: { create: vi.fn().mockResolvedValue({}) },
    };

    prisma.$transaction = vi.fn((fn: (client: any) => unknown) => fn(tx));

    service = new PaymentsService(
      prisma as unknown as PrismaService,
      provider as never,
      provider as never,
      provider as never,
      provider as never,
      { get: () => true } as unknown as ConfigService,
    );
  });

  it('refuses to call a gateway for COD', async () => {
    await expect(
      service.refundWithGateway(PaymentGateway.COD, 'ext-1', dec('100')),
    ).rejects.toThrow(/no gateway to refund/i);
    expect(provider.refundPayment).not.toHaveBeenCalled();
  });

  it('passes minor units to the gateway and returns its refund id', async () => {
    const id = await service.refundWithGateway(
      PaymentGateway.STRIPE,
      'ext-1',
      dec('123.45'),
    );

    expect(provider.refundPayment).toHaveBeenCalledWith('ext-1', 12345);
    expect(id).toBe('gw-refund-1');
  });

  it('completes a pending refund and marks the order partially refunded', async () => {
    prisma.transaction.findUnique.mockResolvedValue({
      id: 'txn-1',
      type: TransactionType.REFUND,
      status: TransactionStatus.PENDING,
      amount: dec('200'),
      orderId: 'order-1',
      note: 'Return ret-1',
    });
    prisma.transaction.findFirst.mockResolvedValue({
      amount: dec('1000'),
      type: TransactionType.PAYMENT,
    });
    // 200 of a 1000 payment is back, so the order is only partly refunded.
    tx.transaction.aggregate.mockResolvedValue({ _sum: { amount: dec('200') } });

    const result = await service.confirmRefund(admin, 'txn-1');

    expect(result.alreadyConfirmed).toBe(false);
    expect(tx.transaction.update.mock.calls[0][0].data.status).toBe(
      TransactionStatus.COMPLETED,
    );
    expect(tx.order.update.mock.calls[0][0].data.paymentStatus).toBe(
      PaymentStatus.PARTIALLY_REFUNDED,
    );
  });

  it('marks the order fully refunded once the refunds cover the payment', async () => {
    prisma.transaction.findUnique.mockResolvedValue({
      id: 'txn-1',
      type: TransactionType.REFUND,
      status: TransactionStatus.PENDING,
      amount: dec('200'),
      orderId: 'order-1',
      note: null,
    });
    prisma.transaction.findFirst.mockResolvedValue({
      amount: dec('200'),
      type: TransactionType.PAYMENT,
    });

    await service.confirmRefund(admin, 'txn-1');

    expect(tx.order.update.mock.calls[0][0].data.paymentStatus).toBe(
      PaymentStatus.REFUNDED,
    );
  });

  it('is a no-op when the refund is already confirmed', async () => {
    prisma.transaction.findUnique.mockResolvedValue({
      id: 'txn-1',
      type: TransactionType.REFUND,
      status: TransactionStatus.COMPLETED,
      amount: dec('200'),
      orderId: 'order-1',
    });

    const result = await service.confirmRefund(admin, 'txn-1');

    expect(result.alreadyConfirmed).toBe(true);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuses to confirm a transaction that is not a refund', async () => {
    prisma.transaction.findUnique.mockResolvedValue({
      id: 'txn-1',
      type: TransactionType.PAYMENT,
      status: TransactionStatus.PENDING,
    });

    await expect(service.confirmRefund(admin, 'txn-1')).rejects.toThrow(
      /not a refund/i,
    );
  });

  it('refuses to confirm a failed refund', async () => {
    prisma.transaction.findUnique.mockResolvedValue({
      id: 'txn-1',
      type: TransactionType.REFUND,
      status: TransactionStatus.FAILED,
    });

    await expect(service.confirmRefund(admin, 'txn-1')).rejects.toThrow(
      /cannot be confirmed/i,
    );
  });
});
