import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { ShippingRateService } from '../src/modules/shipping/shipping-rate.service';
import { PrismaService } from '../src/database/prisma.service';

const zone = (id: string, name: string, districts: string[] = []) => ({
  id,
  name,
  districts,
});

const rate = (
  id: string,
  min: number,
  max: number | null,
  fee: string,
  days: number,
) => ({
  id,
  zoneId: 'zone-1',
  minWeightGrams: min,
  maxWeightGrams: max,
  fee: new Prisma.Decimal(fee),
  estimatedDays: days,
});

describe('ShippingRateService.calculateFee', () => {
  let prisma: {
    shippingZone: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
    shippingRate: { findMany: ReturnType<typeof vi.fn> };
  };
  let service: ShippingRateService;

  beforeEach(() => {
    prisma = {
      shippingZone: { findMany: vi.fn(), findFirst: vi.fn() },
      shippingRate: { findMany: vi.fn() },
    };

    const config = {
      get: (key: string) => (key === 'shipping.defaultZoneName' ? 'DEFAULT' : undefined),
    } as unknown as ConfigService;

    service = new ShippingRateService(
      prisma as unknown as PrismaService,
      config,
    );
  });

  it('sums item weight times quantity', () => {
    const total = ShippingRateService.totalWeightGrams([
      { weightGrams: 500, qty: 3 },
      { weightGrams: 1200, qty: 2 },
    ]);

    expect(total).toBe(1500 + 2400);
  });

  it('matches a district to its zone case-insensitively', async () => {
    prisma.shippingZone.findMany.mockResolvedValue([
      zone('zone-dhaka', 'Dhaka Division', ['Dhaka', 'Gazipur']),
      zone('zone-ctg', 'Chattogram', ['Chattogram', 'Coxs Bazar']),
    ]);
    prisma.shippingRate.findMany.mockResolvedValue([
      rate('r1', 0, 1000, '60.00', 2),
      rate('r2', 1001, null, '120.00', 3),
    ]);

    // 'dHaKa' must still resolve to the Dhaka zone.
    const result = await service.calculateFee(
      [{ weightGrams: 500, qty: 1 }],
      { district: 'dHaKa' },
    );

    expect(result.zoneName).toBe('Dhaka Division');
    expect(result.zoneId).toBe('zone-dhaka');
  });

  it('ignores inactive zones', async () => {
    prisma.shippingZone.findMany.mockResolvedValue([]);
    prisma.shippingZone.findFirst.mockResolvedValue(zone('zone-def', 'DEFAULT'));
    prisma.shippingRate.findMany.mockResolvedValue([
      rate('r1', 0, null, '80.00', 4),
    ]);

    const result = await service.calculateFee([{ weightGrams: 100, qty: 1 }], {
      district: 'Dhaka',
    });

    // The district lookup is filtered by isActive, so an empty result falls
    // through to DEFAULT.
    expect(prisma.shippingZone.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
    expect(result.zoneName).toBe('DEFAULT');
  });

  it('falls back to the DEFAULT zone when no district matches', async () => {
    prisma.shippingZone.findMany.mockResolvedValue([
      zone('zone-dhaka', 'Dhaka Division', ['Dhaka']),
    ]);
    prisma.shippingZone.findFirst.mockResolvedValue(zone('zone-def', 'DEFAULT'));
    prisma.shippingRate.findMany.mockResolvedValue([
      rate('r1', 0, null, '90.00', 5),
    ]);

    const result = await service.calculateFee([{ weightGrams: 500, qty: 1 }], {
      district: 'Sylhet',
    });

    expect(prisma.shippingZone.findFirst).toHaveBeenCalledWith({
      where: { name: 'DEFAULT' },
    });
    expect(result.zoneId).toBe('zone-def');
    expect(result.fee.toFixed(2)).toBe('90.00');
  });

  it('falls back to the DEFAULT zone when the address has no district', async () => {
    prisma.shippingZone.findFirst.mockResolvedValue(zone('zone-def', 'DEFAULT'));
    prisma.shippingRate.findMany.mockResolvedValue([
      rate('r1', 0, null, '90.00', 5),
    ]);

    const result = await service.calculateFee([{ weightGrams: 500, qty: 1 }], {});

    // No district means no district scan at all.
    expect(prisma.shippingZone.findMany).not.toHaveBeenCalled();
    expect(result.zoneName).toBe('DEFAULT');
  });

  it('throws when no district matches and no DEFAULT zone exists', async () => {
    prisma.shippingZone.findMany.mockResolvedValue([]);
    prisma.shippingZone.findFirst.mockResolvedValue(null);

    await expect(
      service.calculateFee([{ weightGrams: 500, qty: 1 }], { district: 'Barishal' }),
    ).rejects.toThrow('No shipping zone matches this address');
  });

  it('picks the band whose range contains the total weight', async () => {
    prisma.shippingZone.findMany.mockResolvedValue([
      zone('zone-1', 'Dhaka Division', ['Dhaka']),
    ]);
    prisma.shippingRate.findMany.mockResolvedValue([
      rate('r1', 0, 500, '50.00', 2),
      rate('r2', 501, 2000, '80.00', 3),
      rate('r3', 2001, null, '130.00', 4),
    ]);

    const result = await service.calculateFee(
      [{ weightGrams: 700, qty: 1 }],
      { district: 'Dhaka' },
    );

    expect(result.fee.toFixed(2)).toBe('80.00');
    expect(result.estimatedDays).toBe(3);
  });

  it('includes the upper bound of a band', async () => {
    prisma.shippingZone.findMany.mockResolvedValue([
      zone('zone-1', 'Dhaka Division', ['Dhaka']),
    ]);
    prisma.shippingRate.findMany.mockResolvedValue([
      rate('r1', 0, 500, '50.00', 2),
      rate('r2', 501, 2000, '80.00', 3),
    ]);

    const result = await service.calculateFee(
      [{ weightGrams: 1000, qty: 2 }],
      { district: 'Dhaka' },
    );

    // 2000 is the inclusive max of band 2.
    expect(result.fee.toFixed(2)).toBe('80.00');
  });

  it('charges the heaviest band when the parcel is overweight', async () => {
    prisma.shippingZone.findMany.mockResolvedValue([
      zone('zone-1', 'Dhaka Division', ['Dhaka']),
    ]);
    prisma.shippingRate.findMany.mockResolvedValue([
      rate('r1', 0, 500, '50.00', 2),
      rate('r2', 501, 2000, '80.00', 3),
    ]);

    const result = await service.calculateFee(
      [{ weightGrams: 5000, qty: 1 }],
      { district: 'Dhaka' },
    );

    // Better to over-quote than ship a 5kg parcel for the small-parcel rate.
    expect(result.fee.toFixed(2)).toBe('80.00');
  });

  it('throws when the matched zone has no rates configured', async () => {
    prisma.shippingZone.findMany.mockResolvedValue([
      zone('zone-1', 'Dhaka Division', ['Dhaka']),
    ]);
    prisma.shippingRate.findMany.mockResolvedValue([]);

    await expect(
      service.calculateFee([{ weightGrams: 500, qty: 1 }], { district: 'Dhaka' }),
    ).rejects.toThrow('No shipping rates configured for zone "Dhaka Division"');
  });

  it('returns the fee as a Prisma.Decimal', async () => {
    prisma.shippingZone.findFirst.mockResolvedValue(zone('zone-def', 'DEFAULT'));
    prisma.shippingRate.findMany.mockResolvedValue([
      rate('r1', 0, null, '99.99', 2),
    ]);

    const result = await service.calculateFee([{ weightGrams: 100, qty: 1 }], {});

    expect(result.fee).toBeInstanceOf(Prisma.Decimal);
    expect(result.fee.toFixed(2)).toBe('99.99');
  });

  it('rejects an inverted weight band', () => {
    expect(() => ShippingRateService.assertRateBand(2000, 500)).toThrow(
      'maxWeightGrams must be greater than or equal to minWeightGrams',
    );
    expect(() => ShippingRateService.assertRateBand(0, null)).not.toThrow();
    expect(() => ShippingRateService.assertRateBand(0, 500)).not.toThrow();
  });
});