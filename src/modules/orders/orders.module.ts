import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../database/prisma.module';
import { RedisCacheModule } from '../../common/cache/redis-cache.module';
import { ProductModule } from '../product/product.module';
import { CouponsModule } from '../coupons/coupons.module';
import { PaymentsModule } from '../payments/payments.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderSplitterService } from './order-splitter.service';
import { OrderStatusService } from '../shipping/order-status.service';
import { ShippingRateService } from '../shipping/shipping-rate.service';

/**
 * OrderStatusService and ShippingRateService live under modules/shipping but are
 * providers of this module too: the status rules and the shipping fee table are
 * part of checkout, and importing ShippingModule here would create a cycle
 * (ShippingModule depends on OrdersModule).
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisCacheModule,
    ProductModule,
    CouponsModule,
    PaymentsModule,
  ],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrderSplitterService,
    OrderStatusService,
    ShippingRateService,
  ],
  exports: [
    OrdersService,
    OrderSplitterService,
    OrderStatusService,
    ShippingRateService,
  ],
})
export class OrdersModule {}