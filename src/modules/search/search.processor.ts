import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SEARCH_INDEX_QUEUE, SearchJob } from './search.constants';
import { SearchService } from './search.service';

/**
 * Applies queued index changes.
 *
 * Meilisearch is enqueued, not awaited, by the write path — so a failure here
 * has to be visible rather than silent. Failures are logged and re-thrown so
 * BullMQ can apply its retry policy; a swallowed error would leave a product
 * permanently missing from search with nothing to alert on.
 */
@Processor(SEARCH_INDEX_QUEUE)
export class SearchProcessor extends WorkerHost {
  private readonly logger = new Logger(SearchProcessor.name);

  constructor(private readonly search: SearchService) {
    super();
  }

  async process(job: Job<SearchJob>): Promise<unknown> {
    const data = job.data;

    switch (data.type) {
      case 'upsert':
        await this.search.indexProduct(data.productId);
        return { indexed: data.productId };

      case 'delete':
        await this.search.removeProduct(data.productId);
        return { removed: data.productId };

      case 'reindex':
        return this.search.reindexAll();

      default: {
        // Exhaustiveness: a new job type added to SearchJob without a case
        // here fails to compile rather than silently dropping products.
        const _never: never = data;
        throw new Error(`Unknown search job: ${JSON.stringify(_never)}`);
      }
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<SearchJob> | undefined, err: Error): void {
    this.logger.error(
      `Search job ${job?.id ?? 'unknown'} failed: ${err.message}`,
    );
  }
}
