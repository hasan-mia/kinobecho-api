import { Injectable } from '@nestjs/common';
import { PaymentGateway, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { PaymentsService } from '../../payments/payments.service';
import { BkashProvider } from '../../payments/providers/bkash.provider';
import { BaseWebhookProcessor, GatewayWebhookContext } from './base-webhook.processor';

@Injectable()
export class BkashWebhookProcessor extends BaseWebhookProcessor {
  protected readonly gateway = PaymentGateway.BKASH;

  constructor(
    prisma: PrismaService,
    payments: PaymentsService,
    private readonly bkash: BkashProvider,
  ) {
    super(prisma, payments, BkashWebhookProcessor.name);
  }

  async process(rawBody: Buffer, body: Record<string, unknown>, signature?: string) {
    this.requireSignature(
      this.bkash.verifyWebhookSignature(rawBody, signature ?? ''),
      'Invalid bKash signature',
    );

    const status = String(body.status ?? '').toUpperCase();
    const context: GatewayWebhookContext = {
      rawBody,
      eventId: `bkash:${String(body.trx_id ?? body.paymentID ?? body.transactionStatus ?? JSON.stringify(body))}`,
      type: `payment.${status.toLowerCase() || 'unknown'}`,
      payload: body as Prisma.InputJsonValue,
      signature,
      externalRef: body.paymentID ? String(body.paymentID) : undefined,
      amount: body.amount ? new Prisma.Decimal(String(body.amount)) : undefined,
      success: status === 'COMPLETED' || status === 'SUCCESS',
      failureReason: body.statusMessage
        ? String(body.statusMessage)
        : undefined,
    };

    return this.handle(context);
  }
}
