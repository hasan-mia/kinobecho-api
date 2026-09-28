import { Injectable } from '@nestjs/common';
import { PaymentGateway, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { PaymentsService } from '../../payments/payments.service';
import { SslCommerzProvider } from '../../payments/providers/sslcommerz.provider';
import { BaseWebhookProcessor, GatewayWebhookContext } from './base-webhook.processor';

@Injectable()
export class SslCommerzWebhookProcessor extends BaseWebhookProcessor {
  protected readonly gateway = PaymentGateway.SSLCOMMERZ;

  constructor(
    prisma: PrismaService,
    payments: PaymentsService,
    private readonly sslcommerz: SslCommerzProvider,
  ) {
    super(prisma, payments, SslCommerzWebhookProcessor.name);
  }

  async process(
    rawBody: Buffer,
    body: Record<string, unknown>,
    signature?: string,
  ) {
    this.requireSignature(
      this.sslcommerz.verifyWebhookSignature(rawBody, signature ?? ''),
      'Invalid SSLCommerz signature',
    );

    const status = String(body.status ?? '').toUpperCase();

    // SSLCommerz sends the sessionkey we stored as externalRef in the callback
    // as `sessionkey`; `val_id` is the bank transaction id.
    const externalRef = body.sessionkey
      ? String(body.sessionkey)
      : body.tran_id
        ? String(body.tran_id)
        : undefined;

    const context: GatewayWebhookContext = {
      rawBody,
      eventId: `sslcommerz:${String(body.sessionkey ?? body.val_id ?? JSON.stringify(body))}`,
      type: `payment.${status.toLowerCase() || 'unknown'}`,
      payload: body as Prisma.InputJsonValue,
      signature,
      externalRef,
      amount: body.amount ? new Prisma.Decimal(String(body.amount)) : undefined,
      success: status === 'VALID' || status === 'VALIDATED' || status === 'SUCCESS',
      failureReason: body.failedreason ? String(body.failedreason) : undefined,
    };

    return this.handle(context);
  }
}
