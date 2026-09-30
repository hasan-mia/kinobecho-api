import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { SearchModule } from '../search/search.module';
import { BrandController } from './brand.controller';
import { BrandService } from './brand.service';

/**
 * Imports SearchModule for SearchSyncService only: a brand rename makes every
 * one of its product documents stale, and re-queueing them is cheaper than
 * waiting for the next full rebuild.
 */
@Module({
  imports: [PrismaModule, SearchModule],
  controllers: [BrandController],
  providers: [BrandService],
  exports: [BrandService],
})
export class BrandModule {}
