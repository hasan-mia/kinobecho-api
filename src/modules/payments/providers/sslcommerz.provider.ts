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

@Injectable()
export class SslCommerzProvider implements PaymentGateway {
  private readonly logger = new Logger(SslCommerzProvider.name);
  private readonly config: {
    storeId: string;
    storePassword: string;
    apiKey: string;
    apiSecret: string;
    sandbox: boolean;
  };

  constructor(private readonly configService: ConfigService) {
    this.config = {
      storeId: this.read('storeId', 'SSLCOMMERZ_STORE_ID'),
      storePassword: this.read('storePassword', 'SSLCOMMERZ_STORE_PASSWORD'),
      apiKey: this.read('apiKey', 'SSLCOMMERZ_API_KEY'),
      apiSecret: this.read('apiSecret', 'SSLCOMMERZ_API_SECRET'),
      sandbox:
        this.configService.get<boolean>('localPayments.sslcommerz.sandbox') ??
        true,
    };
  }

  private read(key: string, envKey: string): string {
    return (
      this.configService.get<string>(`localPayments.sslcommerz.${key}`) ??
      this.configService.get<string>(envKey) ??
      ''
    );
  }

  private get baseUrl(): string {
    return this.config.sandbox
      ? 'https://sandbox.sslcommerz.com'
      : 'https://securepay.sslcommerz.com';
  }

  async createPaymentIntent(
    amount: number,
    currency: string,
    metadata?: Record<string, string>,
  ): Promise<PaymentIntent> {
    const { data } = await axios.post(
      `${this.baseUrl}/gwprocess/v4/api.php`,
      new URLSearchParams({
        store_id: this.config.storeId,
        store_passwd: this.config.storePassword,
        total_amount: amount.toFixed(2),
        currency: currency || 'BDT',
        tran_id: metadata?.orderId ?? `KB-${Date.now()}`,
        success_url: metadata?.successUrl ?? '',
        fail_url: metadata?.failUrl ?? '',
        cus_name: metadata?.customerName ?? 'KinoBecho Customer',
        cus_email: metadata?.customerEmail ?? '',
        cus_phone: metadata?.customerPhone ?? '',
        product_name: metadata?.productName ?? 'KinoBecho order',
        product_category: 'general',
        shipping_method: 'Courier',
      }).toString(),
      {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      },
    );

    if (data?.status !== 'SUCCESS') {
      throw new Error(
        `SSLCommerz session failed: ${data?.failedreason ?? 'unknown error'}`,
      );
    }

    return {
      id: data.sessionkey,
      clientSecret: data.GatewayPageURL,
      amount,
      currency: currency || 'BDT',
      status: 'Created',
      metadata,
    };
  }

  async capturePayment(
    paymentId: string,
    amount?: number,
  ): Promise<Charge> {
    const { data } = await axios.get(
      `${this.baseUrl}/validator/api/validationserverAPI.php`,
      {
        params: {
          val_id: paymentId,
          store_id: this.config.storeId,
          store_passwd: this.config.storePassword,
          format: 'json',
        },
      },
    );

    if (data?.status !== 'VALID') {
      throw new Error(
        `SSLCommerz validation failed: ${data?.failedreason ?? 'invalid transaction'}`,
      );
    }

    return {
      id: data.bank_tran_id ?? paymentId,
      amount: amount ?? Number(data.amount),
      currency: data.currency ?? 'BDT',
      status: data.status,
    };
  }

  async refundPayment(paymentId: string, amount?: number): Promise<Refund> {
    const { data } = await axios.post(
      `${this.baseUrl}/admin/api/transaction/refund.php`,
      new URLSearchParams({
        store_id: this.config.storeId,
        store_passwd: this.config.storePassword,
        tran_id: paymentId,
        amount: (amount ?? 0).toFixed(2),
        reason: 'Customer refund',
      }).toString(),
      {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      },
    );

    if (data?.status !== 'SUCCESS') {
      throw new Error(
        `SSLCommerz refund failed: ${data?.failedreason ?? 'unknown error'}`,
      );
    }

    return {
      id: data.refund_tran_id ?? paymentId,
      amount: amount ?? 0,
      currency: 'BDT',
      status: 'COMPLETED',
    };
  }

  /**
   * SSLCommerz sends an HMAC-SHA512 signature header computed over the raw
   * callback body using the store API secret.
   */
  verifyWebhookSignature(payload: Buffer, signature: string): boolean {
    if (!this.config.apiSecret || !signature) {
      this.logger.warn(
        'SSLCommerz webhook signature not verifiable (missing secret or signature)',
      );
      return false;
    }

    const expected = createHmac('sha512', this.config.apiSecret)
      .update(payload)
      .digest('hex');

    const a = Buffer.from(expected);
    const b = Buffer.from(signature);

    return a.length === b.length && timingSafeEqual(a, b);
  }
}
