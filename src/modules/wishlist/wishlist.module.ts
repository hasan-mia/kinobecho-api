import { Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { ProductModule } from '../product/product.module';
import { WishlistController } from './wishlist.controller';
import { WishlistService } from './wishlist.service';

/**
 * Imports ProductModule for ProductPricingService, the same instance checkout
 * uses: a wishlist price resolved by different rules than the cart would be
 * worse than showing no price at all.
 */
@Module({
  imports: [PrismaModule, ProductModule],
  controllers: [WishlistController],
  providers: [WishlistService],
  exports: [WishlistService],
})
export class WishlistModule {}
