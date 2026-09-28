import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { PaymentGateway, PaymentIntent, Charge, Refund } from '../interfaces/payment-gateway.interface';

@Injectable()
export class StripeProvider implements PaymentGateway {
  private readonly logger = new Logger(StripeProvider.name);
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(private readonly configService: ConfigService) {
    this.stripe = new Stripe(configService.get<string>('STRIPE_SECRET_KEY') as string, {
      apiVersion: '2023-10-16' as any,
    });
    this.webhookSecret = configService.get<string>('STRIPE_WEBHOOK_SECRET') ?? '';
  }

  async createPaymentIntent(
    amount: number,
    currency: string,
    metadata?: Record<string, string>,
  ): Promise<PaymentIntent> {
    const intent = await this.stripe.paymentIntents.create({
      amount,
      currency,
      metadata,
      capture_method: 'manual',
    });

    return {
      id: intent.id,
      clientSecret: intent.client_secret ?? '',
      amount: intent.amount,
      currency: intent.currency,
      status: intent.status,
      metadata: intent.metadata,
    };
  }

  async capturePayment(paymentId: string, amount?: number): Promise<Charge> {
    const intent = await this.stripe.paymentIntents.capture(paymentId, {
      amount_to_capture: amount,
    });

    return {
      id: intent.id,
      amount: intent.amount,
      currency: intent.currency,
      status: intent.status,
    };
  }

  async refundPayment(paymentId: string, amount?: number): Promise<Refund> {
    const intent = await this.stripe.paymentIntents.retrieve(paymentId);

    const refundData: Stripe.RefundCreateParams = {
      payment_intent: intent.id,
    };

    if (amount) {
      refundData.amount = amount;
    }

    const refund = await this.stripe.refunds.create(refundData);

    return {
      id: refund.id,
      amount: refund.amount,
      currency: refund.currency,
      status: refund.status as string,
    };
  }

  verifyWebhookSignature(payload: Buffer, signature: string): boolean {
    if (!this.webhookSecret) {
      this.logger.warn('STRIPE_WEBHOOK_SECRET not configured');
      return false;
    }

    try {
      const event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        this.webhookSecret,
      );
      return true;
    } catch (err) {
      this.logger.error(`Webhook signature verification failed: ${(err as Error).message}`);
      return false;
    }
  }
}
