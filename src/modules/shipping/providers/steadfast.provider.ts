import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ShipmentStatus } from '@prisma/client';
import axios from 'axios';
import {
  CourierProvider,
  CourierStatusResult,
  CreateShipmentInput,
  CreateShipmentResult,
} from '../interfaces/courier-provider.interface';
import {
  STEADFAST_CANCEL_PATH,
  STEADFAST_DEFAULTS,
  STEADFAST_FIELDS,
  STEADFAST_HEADERS,
  STEADFAST_PATHS,
  STEADFAST_RESPONSE_PATHS,
  STEADFAST_STATUS_BY_CID_PATH,
  STEADFAST_STATUS_MAP,
} from './steadfast.constants';

@Injectable()
export class SteadfastProvider implements CourierProvider {
  private readonly logger = new Logger(SteadfastProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly secretKey: string;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = (
      this.configService.get<string>('shipping.steadfast.baseUrl') ??
      this.configService.get<string>('STEADFAST_BASE_URL') ??
      STEADFAST_DEFAULTS.baseUrl
    ).replace(/\/$/, '');

    this.apiKey =
      this.configService.get<string>('shipping.steadfast.apiKey') ??
      this.configService.get<string>('STEADFAST_API_KEY') ??
      '';

    this.secretKey =
      this.configService.get<string>('shipping.steadfast.secretKey') ??
      this.configService.get<string>('STEADFAST_SECRET_KEY') ??
      '';
  }

  /** API-Key / Secret-Key headers, per the Steadfast docs. */
  private headers(): Record<string, string> {
    return {
      [STEADFAST_HEADERS.contentType]: STEADFAST_HEADERS.contentTypeJson,
      [STEADFAST_HEADERS.apiKey]: this.apiKey,
      [STEADFAST_HEADERS.secretKey]: this.secretKey,
    };
  }

  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    try {
      const { data } = await axios.post(
        `${this.baseUrl}${STEADFAST_PATHS.createOrder}`,
        {
          [STEADFAST_FIELDS.invoice]: input.order.orderNumber,
          [STEADFAST_FIELDS.recipientName]: input.address.recipientName,
          [STEADFAST_FIELDS.recipientPhone]: input.address.phone,
          [STEADFAST_FIELDS.recipientAddress]: input.address.address,
          // Prepaid orders send 0 so Steadfast never tries to collect cash.
          [STEADFAST_FIELDS.codAmount]: Number(input.codAmount),
          [STEADFAST_FIELDS.note]: input.itemDescription,
        },
        { headers: this.headers() },
      );

      const consignment = data?.[STEADFAST_RESPONSE_PATHS.consignment];
      const consignmentId = consignment?.[STEADFAST_RESPONSE_PATHS.consignmentId];

      if (!consignmentId) {
        throw new Error(
          `Steadfast returned no consignment_id (success=${data?.success})`,
        );
      }

      return {
        consignmentId: String(consignmentId),
        trackingCode: String(
          consignment?.[STEADFAST_RESPONSE_PATHS.trackingCode] ?? consignmentId,
        ),
        raw: data,
      };
    } catch (error) {
      this.logger.error(
        `Steadfast create_order failed: ${(error as Error).message}`,
      );
      throw new BadGatewayException(
        'Steadfast could not create the shipment. Please try again.',
      );
    }
  }

  async getStatus(consignmentId: string): Promise<CourierStatusResult> {
    try {
      const { data } = await axios.get(
        `${this.baseUrl}${STEADFAST_STATUS_BY_CID_PATH(consignmentId)}`,
        { headers: this.headers() },
      );

      const deliveryStatus = data?.[STEADFAST_RESPONSE_PATHS.deliveryStatus];
      return {
        status: this.mapStatus(deliveryStatus),
        raw: data,
      };
    } catch (error) {
      this.logger.error(
        `Steadfast status_by_cid failed for ${consignmentId}: ${(error as Error).message}`,
      );
      throw new BadGatewayException(
        'Steadfast could not return the shipment status.',
      );
    }
  }

  async cancel(consignmentId: string): Promise<void> {
    try {
      await axios.post(
        `${this.baseUrl}${STEADFAST_CANCEL_PATH(consignmentId)}`,
        {},
        { headers: this.headers() },
      );
    } catch (error) {
      this.logger.error(
        `Steadfast cancel_order failed for ${consignmentId}: ${(error as Error).message}`,
      );
      throw new BadGatewayException(
        'Steadfast could not cancel the shipment.',
      );
    }
  }

  /**
   * Maps a Steadfast `delivery_status` through the single table in
   * steadfast.constants.ts. An unrecognised value returns null so the caller can
   * keep the current status instead of silently moving a parcel forward.
   */
  private mapStatus(deliveryStatus: unknown): ShipmentStatus {
    if (typeof deliveryStatus !== 'string') {
      this.logger.warn(
        `Steadfast returned a non-string delivery_status (${typeof deliveryStatus})`,
      );
      return ShipmentStatus.PENDING;
    }

    const mapped = STEADFAST_STATUS_MAP[deliveryStatus.toLowerCase()];

    if (!mapped) {
      this.logger.warn(
        `Unmapped Steadfast delivery_status "${deliveryStatus}", keeping current status`,
      );
      return ShipmentStatus.PENDING;
    }

    return mapped as ShipmentStatus;
  }
}

/** Exported for unit tests: a missing consignment id is a hard error. */
export function assertConsignmentId(value: unknown): asserts value is string {
  if (!value) {
    throw new BadRequestException('Steadfast did not return a consignment id');
  }
}