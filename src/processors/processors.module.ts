import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../database/prisma.module';
import { OrdersModule } from '../modules/orders/orders.module';
import {
  ORDER_EXPIRY_QUEUE,
  OrderExpiryProcessor,
} from './order-expiry.processor';

/**
 * Hosts background processors that span modules. Each processor is registered as
 * a worker for its own queue; the queue itself is declared here so the processor
 * can both consume jobs and publish its repeatable schedule.
 */
@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    OrdersModule,
    BullModule.registerQueue({ name: ORDER_EXPIRY_QUEUE }),
  ],
  providers: [OrderExpiryProcessor],
})
export class ProcessorsModule {}
