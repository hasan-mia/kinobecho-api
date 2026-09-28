import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PaymentGateway, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { PaymentsService } from '../../payments/payments.service';

export interface GatewayWebhookContext {
  rawBody: Buffer;
  eventId: string;
  type: string;
  payload: Prisma.InputJsonValue;
  signature?: string;
  externalRef?: string;
  amount?: Prisma.Decimal;
  success: boolean;
  failureReason?: string;
}

/**
 * Shared plumbing for gateway webhook processors: idempotency through the
 * WebhookEvent table, signature verification delegated to the provider, and a
 * single ledger write per confirmed payment.
 */
@Injectable()
export abstract class BaseWebhookProcessor {
  protected readonly logger: Logger;

  protected constructor(
    protected readonly prisma: PrismaService,
    protected readonly payments: PaymentsService,
    context: string,
  ) {
    this.logger = new Logger(context);
  }

  protected abstract readonly gateway: PaymentGateway;

  async handle(ctx: GatewayWebhookContext): Promise<{ duplicate: boolean }> {
    const existing = await this.prisma.webhookEvent.findUnique({
      where: { eventId: ctx.eventId },
      select: { id: true },
    });

    if (existing) {
      this.logger.log(
        `Duplicate ${this.gateway} event ${ctx.eventId}, ignoring`,
      );
      return { duplicate: true };
    }

    await this.prisma.webhookEvent.create({
      data: {
        eventId: ctx.eventId,
        provider: this.gateway,
        type: ctx.type,
        payload: ctx.payload,
      },
    });

    if (ctx.success && ctx.externalRef) {
      await this.payments.confirmPayment({
        gateway: this.gateway,
        externalRef: ctx.externalRef,
        rawResponse: ctx.payload,
        amount: ctx.amount,
      });
    } else if (!ctx.success && ctx.externalRef) {
      await this.payments.failPayment(
        this.gateway,
        ctx.externalRef,
        ctx.failureReason ?? `${this.gateway} reported a failed payment`,
      );
    }

    return { duplicate: false };
  }

  protected requireSignature(valid: boolean, message: string) {
    if (!valid) {
      throw new UnauthorizedException(message);
    }
  }

}
