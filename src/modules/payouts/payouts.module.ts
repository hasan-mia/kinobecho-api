import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module';
import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';
import { CommissionService } from './commission.service';
import { LowStockService } from './low-stock.service';
import { VendorAnalyticsService } from './vendor-analytics.service';
import { VendorAnalyticsController, AdminAnalyticsController } from './vendor-analytics.controller';
import { PrismaModule } from '../../database/prisma.module';

@Module({
  imports: [PrismaModule, NotificationModule],
  controllers: [PayoutsController, VendorAnalyticsController, AdminAnalyticsController],
  providers: [
    PayoutsService,
    CommissionService,
    LowStockService,
    VendorAnalyticsService,
  ],
  exports: [PayoutsService, CommissionService, LowStockService, VendorAnalyticsService],
})
export class PayoutsModule {}
