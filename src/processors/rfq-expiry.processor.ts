import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Prisma, QuotationStatus, RfqStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { NotificationService } from '../modules/notification/notification.service';

export const RFQ_EXPIRY_QUEUE = 'rfq-expiry';
const BATCH_SIZE = 200;

/**
 * Closes out requests and offers that have run out of time.
 *
 * Two independent clocks, swept together because either can be the binding one:
 * a quotation lapses at its own `validUntil`, which a vendor is free to set
 * earlier than the request's window, and a request lapses at `expiresAt`. A
 * request whose last live quotation has just expired is closed in the same pass
 * so it stops appearing in the vendor pool immediately rather than lingering
 * until its own deadline.
 *
 * Every write is a conditional `updateMany` on the status, so a sweep running
 * alongside a buyer accepting a quotation cannot overwrite the acceptance: the
 * row moves out from under only one of them.
 */
@Processor(RFQ_EXPIRY_QUEUE, { concurrency: 1 })
@Injectable()
export class RfqExpiryProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(RfqExpiryProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    @InjectQueue(RFQ_EXPIRY_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  /** Keyed by name, so restarts converge on one schedule row. */
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'rfq-expiry-schedule',
      { every: 60_000 },
      { name: 'rfq-expiry-scan', data: {} },
    );

    this.logger.log('Registered RFQ/quotation expiry sweep (every 60s)');
  }

  async process(
    job: Job,
  ): Promise<{ quotations: number; rfqs: number }> {
    const now = new Date();

    const dueQuotations = await this.prisma.quotation.findMany({
      where: { status: QuotationStatus.SENT, validUntil: { lte: now } },
      select: {
        id: true,
        rfqId: true,
        vendor: { select: { userId: true } },
        rfq: { select: { title: true, status: true } },
      },
      take: BATCH_SIZE,
    });

    let quotationCount = 0;

    for (const quotation of dueQuotations) {
      const claimed = await this.prisma.quotation.updateMany({
        where: { id: quotation.id, status: QuotationStatus.SENT },
        data: { status: QuotationStatus.EXPIRED },
      });

      if (claimed.count === 0) {
        continue;
      }

      quotationCount += 1;
      this.notify(quotation.vendor.userId, quotation.rfq.title);
    }

    // Requests past their own deadline, plus any still-open request whose last
    // live quotation has just lapsed.
    const dueRfqs = await this.prisma.rfq.findMany({
      where: {
        status: { in: [RfqStatus.OPEN, RfqStatus.QUOTED] },
        OR: [
          { expiresAt: { lte: now } },
          { quotations: { none: { status: QuotationStatus.SENT } } },
        ],
      },
      select: { id: true, title: true, buyerId: true },
      take: BATCH_SIZE,
    });

    let rfqCount = 0;

    for (const rfq of dueRfqs) {
      const claimed = await this.prisma.rfq.updateMany({
        where: { id: rfq.id, status: { in: [RfqStatus.OPEN, RfqStatus.QUOTED] } },
        data: { status: RfqStatus.EXPIRED },
      });

      if (claimed.count === 0) {
        continue;
      }

      rfqCount += 1;
      this.notify(rfq.buyerId, rfq.title);
    }

    this.logger.log(
      `RFQ sweep expired ${quotationCount} quotation(s) and ${rfqCount} request(s)`,
    );

    return { quotations: quotationCount, rfqs: rfqCount };
  }

  /**
   * Best-effort notice to the other party.
   *
   * A failed push must not stop the sweep: the row is already expired, and the
   * next pass would find nothing to do, so retrying the notification is the
   * only thing that would be lost by letting this throw.
   */
  private notify(userId: string, rfqTitle: string): void {
    void this.notifications
      .sendPushToUser(
        userId,
        'Request for quotation closed',
        `"${rfqTitle}" is no longer open for quotations`,
        {},
      )
      .catch((error: Error) => {
        this.logger.warn(`RFQ expiry notification failed: ${error.message}`);
      });
  }
}
