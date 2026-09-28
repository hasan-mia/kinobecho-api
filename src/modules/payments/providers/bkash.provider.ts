import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PaymentGateway, PaymentIntent, Charge, Refund } from '../interfaces/payment-gateway.interface';

const BKASH_BASE_URL = 'https://tokenized.sandbox.bka.sh/v1.2.0-beta';

@Injectable()
export class BkashProvider implements PaymentGateway {
  private readonly logger = new Logger(BkashProvider.name);
  private readonly config: {
    appKey: string;
    appSecret: string;
    username: string;
    password: string;
    webhookSecret: string;
  };

  constructor(private readonly configService: ConfigService) {
    this.config = {
      appKey: this.read('bkash.appKey'),
      appSecret: this.read('bkash.appSecret'),
      username: this.read('bkash.username'),
      password: this.read('bkash.password'),
      webhookSecret: this.read('bkash.webhookSecret'),
    };
  }

  private read(key: string): string {
    return (
      this.configService.get<string>(`localPayments.${key}`) ??
      this.configService.get<string>(key.split('.').pop()?.toUpperCase() ?? '') ??
      ''
    );
  }

  async createPaymentIntent(
    amount: number,
    currency: string,
    metadata?: Record<string, string>,
  ): Promise<PaymentIntent> {
    const token = await this.grantToken();

    const { data } = await axios.post(
      `${BKASH_BASE_URL}/tokenized/checkout/create/paid`,
      {
        amount: amount.toFixed(2),
        currency: currency || 'BDT',
        intent: 'sale',
        merchantInvoiceNumber: metadata?.orderId ?? Date.now().toString(),
      },
      {
        headers: {
          authorization: token,
          'app-key': this.config.appKey,
          'content-type': 'application/json',
        },
      },
    );

    this.logger.log(`Created bKash payment intent ${data.paymentID}`);

    return {
      id: data.paymentID,
      clientSecret: data.bkashURL,
      amount: Number(data.amount),
      currency: data.currency ?? currency,
      status: data.status ?? 'Created',
      metadata,
    };
  }

  async capturePayment(
    paymentId: string,
    amount?: number,
  ): Promise<Charge> {
    const token = await this.grantToken();

    const { data } = await axios.post(
      `${BKASH_BASE_URL}/tokenized/checkout/execute/paid`,
      { paymentID: paymentId },
      {
        headers: {
          authorization: token,
          'app-key': this.config.appKey,
          'content-type': 'application/json',
        },
      },
    );

    return {
      id: data.trxID ?? paymentId,
      amount: amount ?? Number(data.amount),
      currency: data.currency ?? 'BDT',
      status: data.status ?? 'Completed',
      failureMessage: data.statusMessage,
    };
  }

  async refundPayment(paymentId: string, amount?: number): Promise<Refund> {
    const token = await this.grantToken();

    const { data } = await axios.post(
      `${BKASH_BASE_URL}/tokenized/checkout/payment/refund`,
      {
        paymentID: paymentId,
        amount: (amount ?? 0).toFixed(2),
        sku: paymentId,
        reason: 'Customer refund',
      },
      {
        headers: {
          authorization: token,
          'app-key': this.config.appKey,
          'content-type': 'application/json',
        },
      },
    );

    return {
      id: data.refundTrxID ?? data.trxID ?? paymentId,
      amount: amount ?? Number(data.amount),
      currency: data.currency ?? 'BDT',
      status: data.status ?? 'Completed',
    };
  }

  /**
   * bKash does not sign webhook callbacks with a documented HMAC scheme; the
   * callback carries a `signature` field that this method verifies against
   * BKASH_WEBHOOK_SECRET. When no secret is configured the check is skipped
   * rather than silently accepting every callback.
   */
  verifyWebhookSignature(payload: Buffer, signature: string): boolean {
    if (!this.config.webhookSecret || !signature) {
      this.logger.warn(
        'bKash webhook signature not verifiable (missing BKASH_WEBHOOK_SECRET or signature)',
      );
      return false;
    }

    const expected = createHmac(
      'sha256',
      this.config.webhookSecret,
    )
      .update(payload)
      .digest('hex');

    return safeCompare(expected, signature);
  }

  private async grantToken(): Promise<string> {
    const { data } = await axios.post(
      `${BKASH_BASE_URL}/tokenized/checkout/token/grant`,
      {
        app_key: this.config.appKey,
        app_secret: this.config.appSecret,
        username: this.config.username,
        password: this.config.password,
      },
      { headers: { 'content-type': 'application/json' } },
    );

    return data.id_token;
  }
}

function safeCompare(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);

  if (a.length !== b.length) {
    return false;
  }

  return timingSafeEqual(a, b);
}
