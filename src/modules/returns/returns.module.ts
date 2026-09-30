import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../database/prisma.module';
import { NotificationModule } from '../notification/notification.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { ReturnsController } from './returns.controller';
import { ReturnsService } from './returns.service';

/**
 * Imports OrdersModule rather than declaring its own OrderStatusService: the
 * transition rules and the cancellation side effects must be the *same* provider
 * instance the orders and shipping paths use, or a RETURNED order raised here
 * could pass validation while the rest of the system disagreed about it.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    NotificationModule,
    OrdersModule,
    PaymentsModule,
  ],
  controllers: [ReturnsController],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
