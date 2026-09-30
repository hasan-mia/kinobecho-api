import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, ProductStatus, SaleType, UserRole } from '@prisma/client';
import { ProductPricingService } from '../src/modules/product/pricing/product-pricing.service';
import { PrismaService } from '../src/database/prisma.service';

const dec = (v: string) => new Prisma.Decimal(v);

const product = {
  id: 'p1',
  price: dec('500.00'),
  saleType: SaleType.RETAIL,
  minOrderQty: null,
  priceTiers: [{ minQty: 10, maxQty: null, unitPrice: dec('400.00') }],
};

const saleItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'fsi-1',
  salePrice: dec('299.00'),
  variantId: null,
  stockLimit: 10,
  soldCount: 0,
  ...overrides,
});

function build(flashItems: unknown[] = []) {
  const prisma = {
    product: { findFirst: vi.fn().mockResolvedValue(product) },
    flashSaleItem: { findMany: vi.fn().mockResolvedValue(flashItems) },
  };

  return {
    prisma,
    service: new ProductPricingService(prisma as unknown as PrismaService),
  };
}

describe('ProductPricingService — flash sale beats price tiers', () => {
  let prisma: ReturnType<typeof build>['prisma'];
  let service: ProductPricingService;

  beforeEach(() => {
    ({ prisma, service } = build([saleItem()]));
  });

  it('returns the sale price', async () => {
    expect((await service.resolveUnitPrice('p1', 1)).toFixed(2)).toBe('299.00');
  });

  it('reports which sale item produced the price', async () => {
    // Checkout needs this id to charge the budget against.
    const priced = await service.resolveWithContext('p1', 1);

    expect(priced.flashSaleItemId).toBe('fsi-1');
  });

  it('wins over a price tier the quantity would otherwise hit', async () => {
    // 10 units would be 400.00 from the tier; the sale still applies.
    const priced = await service.resolveWithContext('p1', 10);

    expect(priced.unitPrice.toFixed(2)).toBe('299.00');
  });

  it('applies to a wholesale-only product, where tiers do not reach', async () => {
    prisma.product.findFirst.mockResolvedValue({
      ...product,
      saleType: SaleType.WHOLESALE,
      minOrderQty: 50,
    });

    const priced = await service.resolveWithContext('p1', 50);

    expect(priced.unitPrice.toFixed(2)).toBe('299.00');
  });

  it('falls back to normal pricing when no sale is approved', async () => {
    prisma.flashSaleItem.findMany.mockResolvedValue([]);

    expect((await service.resolveUnitPrice('p1', 1)).toFixed(2)).toBe('500.00');
  });

  it('reports no sale context on the fallback path', async () => {
    prisma.flashSaleItem.findMany.mockResolvedValue([]);

    const priced = await service.resolveWithContext('p1', 1);

    expect(priced.flashSaleItemId).toBeNull();
    expect(priced.unitPrice.toFixed(2)).toBe('500.00');
  });

  it('only queries live, active, approved items', async () => {
    await service.resolveUnitPrice('p1', 1);

    const where = prisma.flashSaleItem.findMany.mock.calls[0]![0].where;

    expect(where.productId).toBe('p1');
    expect(where.status).toBe('APPROVED');
    expect(where.flashSale).toEqual({
      isActive: true,
      startsAt: { lte: expect.any(Date) },
      endsAt: { gte: expect.any(Date) },
    });
  });
});

describe('ProductPricingService — a sold-out sale falls through', () => {
  it('ignores an item that has consumed its budget', async () => {
    const { prisma, service } = build([
      saleItem({ stockLimit: 5, soldCount: 5 }),
    ]);

    // A buyer who arrives after the sale sold out must see the normal price
    // rather than a discount the checkout is about to refuse.
    expect((await service.resolveUnitPrice('p1', 1)).toFixed(2)).toBe('500.00');
  });

  it('still applies while one unit remains', async () => {
    const { service } = build([saleItem({ stockLimit: 5, soldCount: 4 })]);

    expect((await service.resolveUnitPrice('p1', 1)).toFixed(2)).toBe('299.00');
  });

  it('never returns a negative remaining budget', async () => {
    const { service } = build([saleItem({ stockLimit: 5, soldCount: 9 })]);

    await expect(service.resolveUnitPrice('p1', 1)).resolves.toBeDefined();
  });
});

describe('ProductPricingService — variant scoping', () => {
  it('accepts a product-level item for any variant', async () => {
    const { prisma, service } = build([saleItem({ variantId: null })]);

    const priced = await service.resolveWithContext('p1', 1, 'v-1');

    expect(priced.flashSaleItemId).toBe('fsi-1');
    expect(prisma.flashSaleItem.findMany.mock.calls[0]![0].where.OR).toEqual([
      { variantId: null },
      { variantId: 'v-1' },
    ]);
  });

  it('prefers a specific-variant item over the product-level wildcard', async () => {
    const { service } = build([
      saleItem({ id: 'wildcard' }),
      saleItem({ id: 'specific', variantId: 'v-1' }),
    ]);

    // The narrower discount is the one the vendor negotiated for that variant.
    const priced = await service.resolveWithContext('p1', 1, 'v-1');

    expect(priced.flashSaleItemId).toBe('specific');
  });

  it('only offers the product-level item to a caller with no variant', async () => {
    // A variant-scoped discount must not leak onto a product-level lookup.
    const { prisma, service } = build([]);

    await service.resolveWithContext('p1', 1, null);

    expect(prisma.flashSaleItem.findMany.mock.calls[0]![0].where.OR).toEqual([
      { variantId: null },
    ]);
  });

  it('skips a sold-out specific item and still honours the wildcard', async () => {
    const { service } = build([
      saleItem({ id: 'wildcard' }),
      saleItem({
        id: 'specific',
        variantId: 'v-1',
        stockLimit: 2,
        soldCount: 2,
      }),
    ]);

    const priced = await service.resolveWithContext('p1', 1, 'v-1');

    expect(priced.flashSaleItemId).toBe('wildcard');
  });
});
