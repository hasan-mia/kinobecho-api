import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, TransactionStatus, TransactionType } from '@prisma/client';
import { PayoutsService } from '../src/modules/payouts/payouts.service';
import { PrismaService } from '../src/database/prisma.service';
import { AuthenticatedUser } from '../src/common/guards/roles.guard';

const dec = (v: string) => new Prisma.Decimal(v);

const vendorUser = {
  id: 'vendor-user',
  email: 'vendor@example.com',
  name: 'Vendor',
  vendor: { id: 'vendor-1' },
} as unknown as AuthenticatedUser;

describe('PayoutsService.requestPayout — refund deductions', () => {
  let prisma: any;
  let service: PayoutsService;
  let tx: any;

  const order = {
    id: 'order-1',
    orderNumber: 'KB-1',
    vendorId: 'vendor-1',
    grandTotal: dec('1000'),
    status: 'DELIVERED',
    vendorEarning: dec('900'),
  };

  beforeEach(() => {
    prisma = {
      vendor: {
        findUnique: vi.fn().mockResolvedValue({ id: 'vendor-1', payoutMethod: 'BKASH' }),
      },
      order: { findMany: vi.fn().mockResolvedValue([order]) },
      transactionOrder: { findMany: vi.fn().mockResolvedValue([]) },
      transaction: { findMany: vi.fn().mockResolvedValue([]) },
    };

    tx = {
      transaction: {
        create: vi.fn().mockResolvedValue({ id: 'payout-1' }),
      },
      payoutAdjustment: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };

    prisma.$transaction = vi.fn((fn: (client: any) => unknown) => fn(tx));

    service = new PayoutsService(prisma as unknown as PrismaService);
  });

  const adjustments = (rows: { id: string; amount: string }[]) =>
    prisma.transaction.findMany.mockResolvedValue(
      rows.map((row) => ({ id: row.id, amount: dec(row.amount) })),
    );

  it('pays the full snapshot when there is no debt', async () => {
    const payout = await service.requestPayout(vendorUser, ['order-1']);

    const data = tx.transaction.create.mock.calls[0][0].data;
    expect(new Prisma.Decimal(data.amount).toFixed(2)).toBe('900.00');
    expect(payout.id).toBe('payout-1');
  });

  it('only considers debts that no payout has absorbed yet', async () => {
    await service.requestPayout(vendorUser, ['order-1']);

    expect(prisma.transaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: TransactionType.ADJUSTMENT,
          offsetByPayout: null,
        }),
      }),
    );
  });

  it('subtracts the debt from the payout amount', async () => {
    adjustments([{ id: 'adj-1', amount: '250.00' }]);

    await service.requestPayout(vendorUser, ['order-1']);

    const data = tx.transaction.create.mock.calls[0][0].data;
    expect(new Prisma.Decimal(data.amount).toFixed(2)).toBe('650.00');
  });

  it('claims each debt so it cannot be deducted twice', async () => {
    adjustments([{ id: 'adj-1', amount: '250.00' }]);

    await service.requestPayout(vendorUser, ['order-1']);

    expect(tx.payoutAdjustment.createMany).toHaveBeenCalledWith({
      data: {
        payoutId: 'payout-1',
        adjustmentId: 'adj-1',
        amount: dec('250.00'),
      },
      skipDuplicates: true,
    });
  });

  it('refuses to create a payout the debts have already wiped out', async () => {
    adjustments([{ id: 'adj-1', amount: '900.00' }]);

    await expect(service.requestPayout(vendorUser, ['order-1'])).rejects.toThrow(
      /Nothing to pay out/,
    );
    expect(tx.transaction.create).not.toHaveBeenCalled();
  });
});

describe('PayoutsService.reject — releasing refund debts', () => {
  let prisma: any;
  let service: PayoutsService;
  let tx: any;

  beforeEach(() => {
    prisma = {
      transaction: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'payout-1',
          status: TransactionStatus.PENDING,
          type: TransactionType.PAYOUT,
          note: 'Settlement for 1 order(s)',
        }),
      },
    };

    tx = {
      transaction: {
        update: vi.fn().mockResolvedValue({ id: 'payout-1' }),
      },
      payoutAdjustment: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };

    prisma.$transaction = vi.fn((fn: (client: any) => unknown) => fn(tx));

    service = new PayoutsService(prisma as unknown as PrismaService);
  });

  it('releases the debts it was carrying, since no money moved', async () => {
    await service.reject('payout-1', 'account details wrong');

    expect(tx.payoutAdjustment.deleteMany).toHaveBeenCalledWith({
      where: { payoutId: 'payout-1' },
    });
  });

  it('refuses to reject a payout that is not pending', async () => {
    prisma.transaction.findFirst.mockResolvedValue({
      id: 'payout-1',
      status: TransactionStatus.COMPLETED,
      type: TransactionType.PAYOUT,
      note: null,
    });

    await expect(service.reject('payout-1', 'x')).rejects.toThrow(/already/i);
  });
});
