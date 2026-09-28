import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WebhooksController } from './webhooks.controller';
import { PrismaModule } from '../../database/prisma.module';
import { PaymentsModule } from '../payments/payments.module';
import { StripeWebhookProcessor } from './processors/stripe-webhook.processor';
import { BkashWebhookProcessor } from './processors/bkash-webhook.processor';
import { NagadWebhookProcessor } from './processors/nagad-webhook.processor';
import { SslCommerzWebhookProcessor } from './processors/sslcommerz-webhook.processor';

@Module({
  imports: [
    PrismaModule,
    PaymentsModule,
    BullModule.registerQueue({
      name: 'webhooks',
    }),
  ],
  controllers: [WebhooksController],
  providers: [
    StripeWebhookProcessor,
    BkashWebhookProcessor,
    NagadWebhookProcessor,
    SslCommerzWebhookProcessor,
  ],
  exports: [],
})
export class WebhooksModule {}
