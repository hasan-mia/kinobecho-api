import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Public } from '../../common/decorators/public.decorator';
import { ShippingService } from './shipping.service';
import {
  PATHAO_HEADERS,
  PATHAO_WEBHOOK_INTEGRATION_SECRET_HEADER,
  PATHAO_WEBHOOK_PATH,
} from './providers/pathao.constants';
import {
  STEADFAST_HEADERS,
  STEADFAST_WEBHOOK_PATH,
} from './providers/steadfast.constants';

/** Constant-time string compare that tolerates differing lengths. */
export function secureCompare(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) {
    return false;
  }

  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);

  if (bufA.length !== bufB.length) {
    // timingSafeEqual throws on a length mismatch; burn the comparison anyway.
    timingSafeEqual(bufA, bufA);
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

/** Accepts `Bearer <token>` or a bare token. */
export function extractBearer(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }

  const [scheme, ...rest] = header.trim().split(/\s+/);

  // Scheme comparison is case-insensitive per RFC 7235.
  if (scheme?.toLowerCase() === STEADFAST_HEADERS.authorizationScheme.toLowerCase()) {
    return rest.join(' ') || undefined;
  }

  return header;
}

@ApiTags('shipping')
@Controller()
export class ShippingWebhookController {
  constructor(
    private readonly shippingService: ShippingService,
    private readonly configService: ConfigService,
  ) {}

  @Post(STEADFAST_WEBHOOK_PATH)
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Steadfast webhook' })
  @ApiResponse({ status: 200, description: 'Webhook accepted' })
  async steadfast(
    @Body() body: Record<string, unknown>,
    @Headers(STEADFAST_HEADERS.authorization.toLowerCase())
    authorization: string | undefined,
  ) {
    const expected =
      this.configService.get<string>('shipping.steadfast.webhookToken') ??
      this.configService.get<string>('STEADFAST_WEBHOOK_TOKEN') ??
      '';

    const provided = extractBearer(authorization);

    if (!expected || !secureCompare(provided, expected)) {
      throw new UnauthorizedException('Invalid webhook token');
    }

    const result = await this.shippingService.handleSteadfastWebhook(body);

    return { status: 'success', message: result.message };
  }

  @Post(PATHAO_WEBHOOK_PATH)
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Pathao webhook' })
  async pathao(
    @Body() body: Record<string, unknown>,
    @Headers(PATHAO_HEADERS.signature.toLowerCase())
    signature: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const expected =
      this.configService.get<string>('shipping.pathao.webhookSecret') ??
      this.configService.get<string>('PATHAO_WEBHOOK_SECRET') ??
      '';

    if (!expected || !secureCompare(signature, expected)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const result = await this.shippingService.handlePathaoWebhook(body);

    // The integration handshake is acknowledged with 202 + the fixed secret
    // header; Pathao compares it against the merchant dashboard value.
    if (!result.handled) {
      res.status(202);

      const integrationSecret =
        this.configService.get<string>(
          'shipping.pathao.webhookIntegrationSecret',
        ) ??
        this.configService.get<string>('PATHAO_WEBHOOK_INTEGRATION_SECRET') ??
        '';

      if (integrationSecret) {
        res.setHeader(
          PATHAO_WEBHOOK_INTEGRATION_SECRET_HEADER,
          integrationSecret,
        );
      }
    }

    return { status: 'success', message: result.message };
  }
}