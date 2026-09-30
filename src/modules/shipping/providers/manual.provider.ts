import { BadRequestException } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { ShipmentStatus } from '@prisma/client';
import {
  CreateShipmentInput,
  CreateShipmentResult,
  CourierStatusResult,
} from '../interfaces/courier-provider.interface';

export interface ManualShipmentInput {
  trackingCode: string;
  status?: ShipmentStatus;
  note?: string;
}

/**
 * Vendor-driven courier: no outbound API call ever happens. The vendor supplies
 * the tracking code and drives status changes through
 * `PATCH /shipments/:id/status`.
 */
@Injectable()
export class ManualCourierProvider {
  async createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult> {
    throw new BadRequestException(
      'Manual shipments require a tracking code. Use POST /shipments/manual.',
    );
  }

  /** Status for MANUAL shipments comes from the vendor, never from this call. */
  async getStatus(): Promise<CourierStatusResult> {
    throw new BadRequestException(
      'Manual shipments have no courier API. Use PATCH /shipments/:id/status.',
    );
  }

  /** Not supported: there is no consignment to cancel upstream. */
}