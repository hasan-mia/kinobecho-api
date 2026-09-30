import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../database/prisma.module';
import { MailModule } from './mail.module';
import { SmsModule } from './sms.module';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { PromotionCampaignController } from './promotion-campaign.controller';
import { PromotionMailProcessor } from './processors/promotion-mail.processor';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    MailModule,
    SmsModule,
    BullModule.registerQueue({
      name: 'promotion-mail',
    }),
  ],
  controllers: [NotificationController, PromotionCampaignController],
  providers: [NotificationService, PromotionMailProcessor],
  exports: [NotificationService],
})
export class NotificationModule {}