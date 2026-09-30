import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { OrderStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { OrderCancellationService } from '../modules/orders/order-cancellation.service';

export const ORDER_EXPIRY_QUEUE = 'order-expiry';
const BATCH_SIZE = 100;

/**
 * Sweeps unpaid orders whose payment window has closed.
 *
 * Every minute it selects due orders and hands each one to
 * `OrderCancellationService`, which re-reads the order inside its own
 * transaction. That re-read is the whole point: a payment webhook confirming an
 * order at the same moment the sweep sees it may commit first, in which case the
 * cancellation finds a non-PENDING order and writes nothing. The buyer who paid
 * wins, and the sweep is harmless.
 */
@Processor(ORDER_EXPIRY_QUEUE, { concurrency: 1 })
@Injectable()
export class OrderExpiryProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(OrderExpiryProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cancellation: OrderCancellationService,
    @InjectQueue(ORDER_EXPIRY_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  /**
   * Registers the repeatable schedule. `upsertJobScheduler` is keyed by name, so
   * every app instance converges on one schedule row instead of stacking
   * duplicate jobs each time a pod restarts.
   */
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'order-expiry-schedule',
      { every: 60_000 },
      { name: 'order-expiry-scan', data: {} },
    );

    this.logger.log('Registered order-expiry sweep (every 60s)');
  }

  async process(job: Job): Promise<{ scanned: number; cancelled: number }> {
    // Both filters are required, not redundant: `expiresAt` alone would also
    // match a COD order if a stale row still carried a deadline, and
    // `paymentStatus = UNPAID` is what excludes PENDING_COD.
    const due = await this.prisma.order.findMany({
      where: {
        status: OrderStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        expiresAt: { lt: new Date() },
      },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: BATCH_SIZE,
    });

    if (due.length === 0) {
      this.logger.debug('No expired orders to cancel');
      return { scanned: 0, cancelled: 0 };
    }

    let cancelled = 0;

    for (const { id } of due) {
      try {
        const result = await this.cancellation.cancelOrder(
          id,
          null,
          'Payment window expired; order auto-cancelled',
          // Re-assert the precondition the SELECT relied on. If a payment
          // webhook confirmed this order in the last few seconds it is now
          // CONFIRMED, and cancelling it would destroy a paid order.
          { requireStatus: OrderStatus.PENDING },
        );

        if (result.cancelled) {
          cancelled += 1;
          this.logger.log(`Auto-cancelled expired order ${id}`);
        }
      } catch (error) {
        // One bad order must not abort the batch or block every later order.
        this.logger.error(
          `Failed to auto-cancel order ${id}: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    this.logger.log(
      `order-expiry sweep: ${cancelled}/${due.length} order(s) cancelled`,
    );

    return { scanned: due.length, cancelled };
  }
}
