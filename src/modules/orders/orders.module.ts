import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { OrderSplitterService } from './order-splitter.service';
import { PrismaModule } from '../../database/prisma.module';
import { ProductModule } from '../product/product.module';
import { CouponsModule } from '../coupons/coupons.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [PrismaModule, ProductModule, CouponsModule, PaymentsModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderSplitterService],
  exports: [OrdersService, OrderSplitterService],
})
export class OrdersModule {}
