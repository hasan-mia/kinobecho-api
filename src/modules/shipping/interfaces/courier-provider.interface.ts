import { Prisma, ShipmentStatus } from '@prisma/client';

export interface CreateShipmentAddress {
  recipientName: string;
  phone: string;
  /** Single-line address string, already assembled by the caller. */
  address: string;
  city?: string | null;
  district?: string | null;
}

export interface CreateShipmentInput {
  order: {
    id: string;
    orderNumber: string;
  };
  address: CreateShipmentAddress;
  /** Grand total for COD, 0 for prepaid. Always a Decimal. */
  codAmount: Prisma.Decimal;
  itemDescription: string;
  /** Number of distinct items in the parcel. */
  itemQuantity?: number;
  /** Total parcel weight in grams; providers convert to their own unit. */
  weightGrams: number;
  /** Pathao-only hints. Omitted entirely when unknown. */
  recipientCityId?: string | null;
  recipientZoneId?: string | null;
}

export interface CreateShipmentResult {
  consignmentId: string;
  trackingCode: string;
  raw: unknown;
}

export interface CourierStatusResult {
  status: ShipmentStatus;
  raw: unknown;
}

export interface PathaoCity {
  id: string;
  name: string;
}

export interface PathaoZone {
  id: string;
  name: string;
}

/**
 * A courier integration. Implemented by SteadfastProvider, PathaoProvider and
 * ManualCourierProvider (the last two via the factory in courier.factory.ts).
 */
export interface CourierProvider {
  createShipment(input: CreateShipmentInput): Promise<CreateShipmentResult>;
  getStatus(consignmentId: string): Promise<CourierStatusResult>;
  /** Only implemented by couriers that actually support cancellation. */
  cancel?(consignmentId: string): Promise<void>;
  /** Admin-only geo helpers; Pathao implements these. */
  listCities?(): Promise<PathaoCity[]>;
  listZones?(cityId: string): Promise<PathaoZone[]>;
}