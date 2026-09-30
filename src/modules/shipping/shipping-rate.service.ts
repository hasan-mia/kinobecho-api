import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface ShippingAddressLike {
  district?: string | null;
  city?: string | null;
}

export interface WeightedItem {
  weightGrams: number;
  qty: number;
}

export interface ShippingEstimate {
  fee: Prisma.Decimal;
  estimatedDays: number;
  zoneId: string;
  zoneName: string;
}

interface ZoneRow {
  id: string;
  name: string;
  districts?: string[] | null;
}

@Injectable()
export class ShippingRateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private get defaultZoneName(): string {
    return (
      this.configService.get<string>('shipping.defaultZoneName') ??
      this.configService.get<string>('SHIPPING_DEFAULT_ZONE_NAME') ??
      'DEFAULT'
    );
  }

  /** Case-insensitive total parcel weight from the given items. */
  static totalWeightGrams(items: WeightedItem[]): number {
    return items.reduce((sum, item) => sum + item.weightGrams * item.qty, 0);
  }

  /**
   * Resolves the shipping fee for a parcel.
   *
   * Zone selection: the first ACTIVE zone whose `districts` array contains the
   * address district (case-insensitive). When nothing matches — or the address
   * has no district — the zone named by SHIPPING_DEFAULT_ZONE_NAME is used.
   *
   * Rate selection: the band where minWeightGrams <= weight and
   * (maxWeightGrams is null or weight <= maxWeightGrams). Past the heaviest band
   * the top rate is charged rather than shipping for free.
   */
  async calculateFee(
    items: WeightedItem[],
    address: ShippingAddressLike,
  ): Promise<ShippingEstimate> {
    const weightGrams = ShippingRateService.totalWeightGrams(items);

    const zone = await this.resolveZone(address);
    const rates = await this.prisma.shippingRate.findMany({
      where: { zoneId: zone.id },
      orderBy: { minWeightGrams: 'asc' },
    });

    if (rates.length === 0) {
      throw new NotFoundException(
        `No shipping rates configured for zone "${zone.name}"`,
      );
    }

    const rate =
      rates.find(
        (r) =>
          r.minWeightGrams <= weightGrams &&
          (r.maxWeightGrams === null || weightGrams <= r.maxWeightGrams),
      ) ?? rates[rates.length - 1]!;

    return {
      fee: rate.fee,
      estimatedDays: rate.estimatedDays,
      zoneId: zone.id,
      zoneName: zone.name,
    };
  }

  /** District match first, then the configured DEFAULT zone. */
  private async resolveZone(address: ShippingAddressLike): Promise<ZoneRow> {
    const district = address.district?.trim();

    if (district) {
      const zones = (await this.prisma.shippingZone.findMany({
        where: { isActive: true },
        select: { id: true, name: true, districts: true },
      })) as ZoneRow[];

      const needle = district.toLowerCase();
      const match = zones.find((zone) =>
        (zone.districts ?? []).some((d) => d.toLowerCase() === needle),
      );

      if (match) {
        return match;
      }
    }

    const fallback = await this.prisma.shippingZone.findFirst({
      where: { name: this.defaultZoneName },
    });

    if (!fallback) {
      throw new NotFoundException(
        `No shipping zone matches this address and no "${this.defaultZoneName}" zone exists`,
      );
    }

    return fallback;
  }

  /** Rejects a band whose max is below its min, which would never be matchable. */
  static assertRateBand(
    minWeightGrams: number,
    maxWeightGrams: number | null,
  ) {
    if (maxWeightGrams !== null && maxWeightGrams < minWeightGrams) {
      throw new BadRequestException(
        'maxWeightGrams must be greater than or equal to minWeightGrams',
      );
    }
  }
}