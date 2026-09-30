import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotationStatus, RfqStatus } from '@prisma/client';
import { RfqExpiryProcessor } from '../src/processors/rfq-expiry.processor';

/**
 * The expiry sweep. Prisma is mocked, so these tests pin the *query* the sweep
 * sends as much as the writes it makes: the interesting failure mode here is a
 * request being retired before it was ever answered, and that is decided by the
 * `where` clause rather than by any code after the query.
 */
describe('RfqExpiryProcessor', () => {
  let prisma: {
    quotation: { findMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
    rfq: { findMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  };
  let notifications: { sendPushToUser: ReturnType<typeof vi.fn> };
  let processor: RfqExpiryProcessor;

  const build = () => {
    prisma = {
      quotation: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      rfq: {
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };
    notifications = { sendPushToUser: vi.fn().mockResolvedValue({ successCount: 1, failedCount: 0 }) };

    processor = new RfqExpiryProcessor(
      prisma as never,
      notifications as never,
      { upsertJobScheduler: vi.fn() } as never,
    );

    return { prisma, notifications };
  };

  /** First argument the sweep passed to `fn`, asserted to exist. */
  const firstArg = (fn: ReturnType<typeof vi.fn>): Record<string, any> => {
    const call = fn.mock.calls[0];
    expect(call).toBeDefined();
    return call![0] as Record<string, any>;
  };

  /** The full positional argument list of the first call to `fn`. */
  const callArgs = (fn: ReturnType<typeof vi.fn>): unknown[] => {
    const call = fn.mock.calls[0];
    expect(call).toBeDefined();
    return call!;
  };

  /** The RFQ sweep filter, for readable assertions. */
  const rfqWhere = (prisma: { rfq: { findMany: ReturnType<typeof vi.fn> } }) =>
    firstArg(prisma.rfq.findMany).where as Record<string, any>;

  /** The per-request condition that retires a request early. */
  const spentCondition = (where: Record<string, unknown>) => {
    const clauses = (where.OR ?? []) as Record<string, unknown>[];
    const spent = clauses.find((c) => c.quotations !== undefined);
    expect(spent, 'expected a condition retiring a request whose offers are all dead')
      .toBeDefined();
    return spent!.quotations as Record<string, unknown>;
  };

  beforeEach(() => {
    vi.useRealTimers();
  });

  it('leaves a request nobody has quoted on yet alone', async () => {
    // The regression this guards: "no live quotations" also describes a request
    // that was posted thirty seconds ago and has not been answered. Treating the
    // two alike retires every request a minute after it is filed.
    const { prisma: db } = build();
    await processor.process({} as never);

    const condition = spentCondition(rfqWhere(db));

    expect(condition.none).toEqual({ status: QuotationStatus.SENT });
    // Without this half, an unanswered request is indistinguishable from a spent one.
    expect(condition.some).toEqual({});
  });

  it('retires a request whose every offer has lapsed or been turned down', async () => {
    const { prisma: db } = build();
    await processor.process({} as never);

    const condition = spentCondition(rfqWhere(db));
    expect(condition.some).toEqual({});
    expect(condition.none).toEqual({ status: QuotationStatus.SENT });
  });

  it('retires a request past its own deadline even while an offer is live', async () => {
    const { prisma: db } = build();
    prisma.rfq.findMany.mockResolvedValue([
      { id: 'rfq-1', title: '500 bulbs', buyerId: 'buyer-1' },
    ]);

    const result = await processor.process({} as never);

    expect(result.rfqs).toBe(1);
    const where = rfqWhere(db);
    const deadline = (where.OR as Record<string, unknown>[])[0];
    expect(deadline).toEqual({ expiresAt: { lte: expect.any(Date) } });
  });

  it('only considers requests still open or quoted', async () => {
    const { prisma: db } = build();
    await processor.process({} as never);

    // An accepted request already became an order; re-expiring it would be wrong.
    expect(rfqWhere(db).status).toEqual({
      in: [RfqStatus.OPEN, RfqStatus.QUOTED],
    });
  });

  it('does not overwrite a request a buyer accepted mid-sweep', async () => {
    const { prisma: db } = build();
    prisma.rfq.findMany.mockResolvedValue([
      { id: 'rfq-1', title: '500 bulbs', buyerId: 'buyer-1' },
    ]);
    // The conditional update loses the race: the row is no longer OPEN/QUOTED.
    prisma.rfq.updateMany.mockResolvedValue({ count: 0 });

    const result = await processor.process({} as never);

    expect(result.rfqs).toBe(0);
    expect(notifications.sendPushToUser).not.toHaveBeenCalled();
  });

  it('expires a lapsed offer and tells the vendor', async () => {
    const { prisma: db } = build();
    prisma.quotation.findMany.mockResolvedValue([
      { id: 'q-1', rfqId: 'rfq-1', vendor: { userId: 'vendor-user' }, rfq: { title: '500 bulbs', status: RfqStatus.QUOTED } },
    ]);

    const result = await processor.process({} as never);

    expect(result.quotations).toBe(1);
    expect(firstArg(db.quotation.updateMany)).toMatchObject({
      where: { id: 'q-1', status: QuotationStatus.SENT },
      data: { status: QuotationStatus.EXPIRED },
    });
    expect(notifications.sendPushToUser).toHaveBeenCalledWith(
      'vendor-user',
      expect.stringContaining('quotation'),
      expect.stringContaining('500 bulbs'),
      {},
    );
  });

  it('sweeps only offers that are still SENT and past their validUntil', async () => {
    const { prisma: db } = build();
    await processor.process({} as never);

    const where = firstArg(db.quotation.findMany).where as Record<string, any>;
    // An accepted or already-rejected offer must not be re-expired.
    expect(where.status).toBe(QuotationStatus.SENT);
    expect(where.validUntil.lte).toEqual(expect.any(Date));
  });

  it('skips an offer a buyer accepted between the read and the write', async () => {
    const { prisma: db } = build();
    prisma.quotation.findMany.mockResolvedValue([
      { id: 'q-1', rfqId: 'rfq-1', vendor: { userId: 'vendor-user' }, rfq: { title: '500 bulbs', status: RfqStatus.ACCEPTED } },
    ]);
    prisma.quotation.updateMany.mockResolvedValue({ count: 0 });

    const result = await processor.process({} as never);

    expect(result.quotations).toBe(0);
    expect(notifications.sendPushToUser).not.toHaveBeenCalled();
  });

  it('finishes the sweep when a push fails', async () => {
    const { prisma: db, notifications: notify } = build();
    notify.sendPushToUser.mockRejectedValue(new Error('FCM unavailable'));
    prisma.rfq.findMany.mockResolvedValue([
      { id: 'rfq-1', title: '500 bulbs', buyerId: 'buyer-1' },
    ]);

    // The row is already expired, so a lost push is not worth failing the job over.
    await expect(processor.process({} as never)).resolves.toEqual({
      quotations: 0,
      rfqs: 1,
    });
  });

  it('tells the buyer when a request closes, not that their offer lapsed', async () => {
    const { notifications: notify } = build();
    prisma.rfq.findMany.mockResolvedValue([
      { id: 'rfq-1', title: '500 bulbs', buyerId: 'buyer-1' },
    ]);

    await processor.process({} as never);

    expect(notify.sendPushToUser).toHaveBeenCalledWith(
      'buyer-1',
      expect.stringContaining('closed'),
      expect.stringContaining('500 bulbs'),
      {},
    );
  });

  it('registers one repeatable schedule so restarts do not stack sweeps', async () => {
    const queue = { upsertJobScheduler: vi.fn().mockResolvedValue(undefined) };
    const p = new RfqExpiryProcessor(prisma as never, notifications as never, queue as never);

    await p.onModuleInit();

    // Keyed by name, so a second boot converges on the same schedule row.
    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    const [schedulerId, every] = callArgs(queue.upsertJobScheduler) as [string, unknown];
    expect(schedulerId).toBe('rfq-expiry-schedule');
    expect(every).toEqual({ every: 60_000 });
  });
});
