import { Injectable } from '@nestjs/common';
import { PaymentGateway, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { PaymentsService } from '../../payments/payments.service';
import { NagadProvider } from '../../payments/providers/nagad.provider';
import { BaseWebhookProcessor, GatewayWebhookContext } from './base-webhook.processor';

@Injectable()
export class NagadWebhookProcessor extends BaseWebhookProcessor {
  protected readonly gateway = PaymentGateway.NAGAD;

  constructor(
    prisma: PrismaService,
    payments: PaymentsService,
    private readonly nagad: NagadProvider,
  ) {
    super(prisma, payments, NagadWebhookProcessor.name);
  }

  async process(
    rawBody: Buffer,
    body: Record<string, unknown>,
    signature?: string,
  ) {
    this.requireSignature(
      this.nagad.verifyWebhookSignature(rawBody, signature ?? ''),
      'Invalid Nagad signature',
    );

    const status = String(body.status ?? '').toUpperCase();

    const context: GatewayWebhookContext = {
      rawBody,
      eventId: `nagad:${String(body.reference_transaction_id ?? body.sessionKey ?? JSON.stringify(body))}`,
      type: `payment.${status.toLowerCase() || 'unknown'}`,
      payload: body as Prisma.InputJsonValue,
      signature,
      externalRef: body.sessionKey
        ? String(body.sessionKey)
        : body.reference_transaction_id
          ? String(body.reference_transaction_id)
          : undefined,
      amount: body.amount ? new Prisma.Decimal(String(body.amount)) : undefined,
      success: status === 'SUCCESS',
      failureReason: body.status ? String(body.status) : undefined,
    };

    return this.handle(context);
  }
}
