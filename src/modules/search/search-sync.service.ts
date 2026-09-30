import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { SEARCH_INDEX_QUEUE, SearchJob } from './search.constants';

/**
 * The write side of the search index: everything that changes a product queues
 * a job, and nothing calls Meilisearch inline.
 *
 * A search index is a cache of Postgres, never a source of truth. A product
 * write that failed because Meilisearch was briefly unreachable must still
 * succeed — the buyer's order must not be rejected because a search box was
 * down — so enqueue failures are logged and swallowed. The cost of swallowing
 * is a stale document, which `scripts/reindex-search.ts` exists to repair.
 */
@Injectable()
export class SearchSyncService {
  private readonly logger = new Logger(SearchSyncService.name);

  constructor(
    @InjectQueue(SEARCH_INDEX_QUEUE) private readonly queue: Queue<SearchJob>,
  ) {}

  async enqueueUpsert(productId: string): Promise<void> {
    await this.enqueue({ type: 'upsert', productId }, `upsert:${productId}`);
  }

  async enqueueDelete(productId: string): Promise<void> {
    await this.enqueue({ type: 'delete', productId }, `delete:${productId}`);
  }

  async enqueueReindex(): Promise<void> {
    await this.enqueue({ type: 'reindex' }, 'reindex');
  }

  private async enqueue(job: SearchJob, jobId: string): Promise<void> {
    try {
      // A stable jobId means a product edited five times in a row queues one
      // job that reads the final state, not five jobs replaying it.
      await this.queue.add(job.type, job, {
        jobId,
        removeOnComplete: 1000,
        removeOnFail: 5000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      });
    } catch (err) {
      this.logger.warn(
        `Could not queue search job ${jobId}: ${(err as Error).message}. ` +
          'The index will be stale until the next reindex.',
      );
    }
  }
}
