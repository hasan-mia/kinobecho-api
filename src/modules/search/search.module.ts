import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { Meilisearch } from 'meilisearch';
import { PrismaModule } from '../../database/prisma.module';
import { RedisCacheModule } from '../../common/cache/redis-cache.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { SearchSyncService } from './search-sync.service';
import { SearchProcessor } from './search.processor';
import { MEILI_CLIENT, SEARCH_INDEX_QUEUE } from './search.constants';

/**
 * The client is built here rather than inside SearchService so a test can
 * supply a fake without constructing a real HTTP client, and so the host and
 * key are read from one place.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisCacheModule,
    BullModule.registerQueue({ name: SEARCH_INDEX_QUEUE }),
  ],
  controllers: [SearchController],
  providers: [
    {
      provide: MEILI_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Meilisearch({
          host: config.get<string>('search.host') ?? 'http://localhost:7700',
          apiKey: config.get<string>('search.apiKey'),
          // A search box that hangs holds a request open; a short timeout makes
          // the Postgres fallback the common case during an outage instead of
          // the exception.
          timeout: 3000,
        }),
    },
    SearchService,
    SearchSyncService,
    SearchProcessor,
  ],
  exports: [SearchService, SearchSyncService],
})
export class SearchModule {}
