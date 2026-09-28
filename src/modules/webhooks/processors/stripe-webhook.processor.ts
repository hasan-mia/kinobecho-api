import { Injectable } from '@nestjs/common';
import { PaymentGateway, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { PaymentsService } from '../../payments/payments.service';
import { StripeProvider } from '../../payments/providers/stripe.provider';
import { BaseWebhookProcessor, GatewayWebhookContext } from './base-webhook.processor';

@Injectable()
export class StripeWebhookProcessor extends BaseWebhookProcessor {
  protected readonly gateway = PaymentGateway.STRIPE;

  constructor(
    prisma: PrismaService,
    payments: PaymentsService,
    private readonly stripe: StripeProvider,
  ) {
    super(prisma, payments, StripeWebhookProcessor.name);
  }

  async process(
    rawBody: Buffer,
    event: { id: string; type: string; data: { object: Record<string, unknown> } },
    signature: string,
  ) {
    this.requireSignature(
      this.stripe.verifyWebhookSignature(rawBody, signature),
      'Invalid Stripe signature',
    );

    const object = event.data?.object ?? {};
    const intent = object as {
      id?: string;
      amount?: number;
      status?: string;
      metadata?: Record<string, string>;
    };

    const isPaymentEvent =
      event.type === 'payment_intent.succeeded' ||
      event.type === 'checkout.session.completed';

    const isFailure = event.type.endsWith('.payment_failed');

    if (!isPaymentEvent && !isFailure) {
      this.logger.log(`Unhandled Stripe event type ${event.type}`);
      return { duplicate: false, handled: false };
    }

    const context: GatewayWebhookContext = {
      rawBody,
      eventId: `stripe:${event.id}`,
      type: event.type,
      payload: JSON.parse(rawBody.toString('utf8')) as Prisma.InputJsonValue,
      signature,
      externalRef: intent.id,
      amount: intent.amount ? new Prisma.Decimal(intent.amount / 100) : undefined,
      success: isPaymentEvent,
      failureReason: intent.status,
    };

    const result = await this.handle(context);

    return { ...result, handled: true };
  }
}
