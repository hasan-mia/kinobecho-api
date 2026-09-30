import { Module } from '@nestjs/common';
import { CmsController } from './cms.controller';
import { CmsService } from './cms.service';
import { PrismaModule } from '../../database/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { ProductModule } from '../product/product.module';

/**
 * Imports ProductModule for ProductPricingService and StorageModule for the
 * banner image pipeline, so a home price is resolved by the same rules checkout
 * enforces and a banner creative gets the same B5 variants as a product image.
 */
@Module({
  imports: [PrismaModule, StorageModule, ProductModule],
  controllers: [CmsController],
  providers: [CmsService],
  exports: [CmsService],
})
export class CmsModule {}
