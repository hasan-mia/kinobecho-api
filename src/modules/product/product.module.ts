import { Module } from '@nestjs/common';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { ProductImageService } from './product-image.service';
import { ProductPricingService } from './pricing/product-pricing.service';
import { PrismaModule } from '../../database/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { SearchModule } from '../search/search.module';

@Module({
  imports: [PrismaModule, StorageModule, SearchModule],
  controllers: [ProductController],
  providers: [ProductService, ProductImageService, ProductPricingService],
  exports: [ProductService, ProductImageService, ProductPricingService],
})
export class ProductModule {}
