import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { BkashWebhookProcessor } from './processors/bkash-webhook.processor';
import { NagadWebhookProcessor } from './processors/nagad-webhook.processor';
import { SslCommerzWebhookProcessor } from './processors/sslcommerz-webhook.processor';
import { StripeWebhookProcessor } from './processors/stripe-webhook.processor';

type RawRequest = RawBodyRequest<Request>;

/**
 * Raw gateway webhook ingress. Signature verification and the ledger write live
 * in the per-gateway processors under `src/modules/webhooks/processors/`.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly stripeProcessor: StripeWebhookProcessor,
    private readonly bkashProcessor: BkashWebhookProcessor,
    private readonly nagadProcessor: NagadWebhookProcessor,
    private readonly sslcommerzProcessor: SslCommerzWebhookProcessor,
  ) {}

  @Post('stripe')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Handle Stripe webhook events' })
  @ApiResponse({ status: 200, description: 'Webhook accepted' })
  async handleStripeWebhook(
    @Req() req: RawRequest,
    @Body() body: { id: string; type: string; data: { object: Record<string, unknown> } },
    @Headers('stripe-signature') signature: string,
  ) {
    const result = await this.stripeProcessor.process(
      req.rawBody ?? Buffer.from(JSON.stringify(body)),
      body,
      signature,
    );

    return { received: true, ...result };
  }

  @Post('bkash')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Handle bKash webhook events' })
  async handleBkashWebhook(
    @Req() req: RawRequest,
    @Body() body: Record<string, unknown>,
    @Headers('bkash-signature') signature?: string,
  ) {
    const result = await this.bkashProcessor.process(
      req.rawBody ?? Buffer.from(JSON.stringify(body)),
      body,
      signature,
    );

    return { received: true, ...result };
  }

  @Post('nagad')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Handle Nagad webhook events' })
  async handleNagadWebhook(
    @Req() req: RawRequest,
    @Body() body: Record<string, unknown>,
    @Headers('x-signature') signature?: string,
  ) {
    const result = await this.nagadProcessor.process(
      req.rawBody ?? Buffer.from(JSON.stringify(body)),
      body,
      signature,
    );

    return { received: true, ...result };
  }

  @Post('sslcommerz')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Handle SSLCommerz webhook events' })
  async handleSslCommerzWebhook(
    @Req() req: RawRequest,
    @Body() body: Record<string, unknown>,
    @Headers('x-hmac-signature') signature?: string,
  ) {
    const result = await this.sslcommerzProcessor.process(
      req.rawBody ?? Buffer.from(JSON.stringify(body)),
      body,
      signature,
    );

    return { received: true, ...result };
  }
}
