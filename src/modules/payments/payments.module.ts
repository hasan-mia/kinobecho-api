import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { StripeProvider } from './providers/stripe.provider';
import { BkashProvider } from './providers/bkash.provider';
import { NagadProvider } from './providers/nagad.provider';
import { SslCommerzProvider } from './providers/sslcommerz.provider';
import { PrismaModule } from '../../database/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    StripeProvider,
    BkashProvider,
    NagadProvider,
    SslCommerzProvider,
  ],
  exports: [PaymentsService, StripeProvider, BkashProvider, NagadProvider, SslCommerzProvider],
})
export class PaymentsModule {}
