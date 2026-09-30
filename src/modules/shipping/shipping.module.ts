import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../database/prisma.module';
import { RedisCacheModule } from '../../common/cache/redis-cache.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { ShippingController } from './shipping.controller';
import { ShipmentsController } from './shipments.controller';
import { ShippingWebhookController } from './shipping-webhook.controller';
import { ShippingService } from './shipping.service';
import { CourierFactory } from './courier.factory';
import { SteadfastProvider } from './providers/steadfast.provider';
import { PathaoProvider } from './providers/pathao.provider';
import { ManualCourierProvider } from './providers/manual.provider';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisCacheModule,
    OrdersModule,
    PaymentsModule,
  ],
  controllers: [
    ShippingController,
    ShipmentsController,
    ShippingWebhookController,
  ],
  providers: [
    ShippingService,
    CourierFactory,
    SteadfastProvider,
    PathaoProvider,
    ManualCourierProvider,
  ],
  exports: [ShippingService, CourierFactory],
})
export class ShippingModule {}