import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  PaymentGateway,
  PaymentIntent,
  Charge,
  Refund,
} from '../interfaces/payment-gateway.interface';

const NAGAD_BASE_URL = 'https://api.sandbox.nagad.com';

@Injectable()
export class NagadProvider implements PaymentGateway {
  private readonly logger = new Logger(NagadProvider.name);
  private readonly config: {
    merchantId: string;
    apiKey: string;
    apiSecret: string;
    webhookSecret: string;
  };

  constructor(private readonly configService: ConfigService) {
    this.config = {
      merchantId: this.read('merchantId', 'NAGAD_MERCHANT_ID'),
      apiKey: this.read('apiKey', 'NAGAD_API_KEY'),
      apiSecret: this.read('apiSecret', 'NAGAD_API_SECRET'),
      webhookSecret: this.read('webhookSecret', 'NAGAD_WEBHOOK_SECRET'),
    };
  }

  private read(key: string, envKey: string): string {
    return (
      this.configService.get<string>(`localPayments.nagad.${key}`) ??
      this.configService.get<string>(envKey) ??
      ''
    );
  }

  async createPaymentIntent(
    amount: number,
    currency: string,
    metadata?: Record<string, string>,
  ): Promise<PaymentIntent> {
    const token = await this.requestToken(amount);

    return {
      id: token.session_key,
      clientSecret: `${token.checkURL_url}?SessionKey=${token.session_key}`,
      amount,
      currency: currency || 'BDT',
      status: 'Created',
      metadata,
    };
  }

  async capturePayment(
    paymentId: string,
    _amount?: number,
  ): Promise<Charge> {
    const { data } = await axios.post(
      `${NAGAD_BASE_URL}/api/merchant/transaction/status`,
      { sessionKey: paymentId },
      { headers: this.authHeaders() },
    );

    return {
      id: data.reference_transaction_id ?? paymentId,
      amount: Number(data.amount),
      currency: data.currency ?? 'BDT',
      status: data.status,
      failureMessage: data.status,
    };
  }

  async refundPayment(paymentId: string, amount?: number): Promise<Refund> {
    const { data } = await axios.post(
      `${NAGAD_BASE_URL}/api/merchant/transaction/refund`,
      { reference_transaction_id: paymentId, amount: amount?.toFixed(2) },
      { headers: this.authHeaders() },
    );

    return {
      id: data.refund_reference_transaction_id ?? paymentId,
      amount: amount ?? 0,
      currency: 'BDT',
      status: data.status ?? 'Completed',
    };
  }

  /**
   * Nagad signs the payment status callback with an HMAC-SHA256 signature over
   * the raw payload using the merchant secret.
   */
  verifyWebhookSignature(payload: Buffer, signature: string): boolean {
    if (!this.config.webhookSecret || !signature) {
      this.logger.warn(
        'Nagad webhook signature not verifiable (missing secret or signature)',
      );
      return false;
    }

    const expected = createHmac('sha256', this.config.webhookSecret)
      .update(payload)
      .digest('hex');

    const a = Buffer.from(expected);
    const b = Buffer.from(signature);

    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async requestToken(amount: number) {
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({
      merchantId: this.config.merchantId,
      orderId: `${Date.now()}`,
      amount: amount.toFixed(2),
    });

    const signature = createHmac('sha256', this.config.apiSecret)
      .update(`${timestamp}${body}`)
      .digest('hex');

    const { data } = await axios.post(
      `${NAGAD_BASE_URL}/api/merchant/checkout/initialize`,
      body,
      {
        headers: {
          'X-Key': this.config.apiKey,
          'X-Secret': this.config.apiSecret,
          'X-Timestamp': timestamp,
          'X-Signature': signature,
          'content-type': 'application/json',
        },
      },
    );

    return data;
  }

  private authHeaders() {
    const timestamp = new Date().toISOString();
    const signature = createHmac('sha256', this.config.apiSecret)
      .update(`${this.config.apiKey}${timestamp}`)
      .digest('hex');

    return {
      'X-Key': this.config.apiKey,
      'X-Secret': this.config.apiSecret,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
    };
  }
}
