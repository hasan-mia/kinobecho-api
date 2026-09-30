import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FlashSaleItemStatus,
  Prisma,
  ProductStatus,
  UserRole,
} from '@prisma/client';
import { FlashSaleService } from '../src/modules/flash-sale/flash-sale.service';
import { PrismaService } from '../src/database/prisma.service';
import { RedisCacheService } from '../src/common/cache/redis-cache.service';
import { AuthenticatedUser } from '../src/common/guards/roles.guard';

const dec = (v: string) => new Prisma.Decimal(v);

const vendor = (vendorId: string) =>
  ({
    id: 'vendor-user',
    role: UserRole.VENDOR,
    vendor: { id: vendorId, slug: 'v', businessName: 'V', status: 'ACTIVE' },
  }) as unknown as AuthenticatedUser;

const product = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'Widget',
  slug: 'widget',
  vendorId: 'vendor-1',
  price: dec('500.00'),
  status: ProductStatus.ACTIVE,
  ...overrides,
});

function build() {
  const prisma = {
    flashSale: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({ id: 'fs-1', items: [] }),
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'fs-1', ...data })),
      update: vi.fn().mockImplementation(async ({ where, data }) => ({ id: where.id, ...data })),
      delete: vi.fn().mockResolvedValue(undefined),
      count: vi.fn().mockResolvedValue(0),
    },
    flashSaleItem: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'fsi-1', ...data })),
      update: vi.fn().mockImplementation(async ({ where, data }) => ({ id: where.id, ...data })),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    product: { findFirst: vi.fn().mockResolvedValue(product()) },
    productVariant: {
      findUnique: vi.fn().mockResolvedValue({ id: 'v-1', productId: 'p1', stock: 20 }),
      findMany: vi.fn().mockResolvedValue([{ stock: 20 }]),
    },
    $transaction: vi.fn().mockImplementation(async (arg) =>
      Array.isArray(arg) ? Promise.all(arg) : arg([]),
    ),
  };

  const cache = {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  };

  return {
    prisma,
    cache,
    service: new FlashSaleService(
      prisma as unknown as PrismaService,
      cache as unknown as RedisCacheService,
    ),
  };
}

const nominateDto = (overrides: Record<string, unknown> = {}) =>
  ({
    productId: 'p1',
    salePrice: '299.00',
    stockLimit: 10,
    ...overrides,
  }) as never;

describe('FlashSaleService.nominate — vendor ownership', () => {
  let h: ReturnType<typeof build>;

  beforeEach(() => {
    h = build();
  });

  it('accepts a nomination for the vendor own product', async () => {
    const item = await h.service.nominate(vendor('vendor-1'), 'fs-1', nominateDto());

    expect(item.id).toBe('fsi-1');
  });

  it('refuses a vendor nominating someone else product', async () => {
    await expect(
      h.service.nominate(vendor('vendor-2'), 'fs-1', nominateDto()),
    ).rejects.toThrow(/only nominate your own products/i);

    expect(h.prisma.flashSaleItem.create).not.toHaveBeenCalled();
  });

  it('refuses a user with no vendor', async () => {
    const customer = { id: 'c1', role: UserRole.CUSTOMER, vendor: null } as never;

    await expect(
      h.service.nominate(customer, 'fs-1', nominateDto()),
    ).rejects.toThrow(/only nominate your own products/i);
  });

  it('files the nomination as NOMINATED, not approved', async () => {
    // The gate is the whole point: a vendor must not be able to grant a
    // discount by inserting a row.
    await h.service.nominate(vendor('vendor-1'), 'fs-1', nominateDto());

    expect(h.prisma.flashSaleItem.create.mock.calls[0]![0].data.status).toBe(
      FlashSaleItemStatus.NOMINATED,
    );
  });

  it('defaults perUserLimit to 1', async () => {
    await h.service.nominate(vendor('vendor-1'), 'fs-1', nominateDto());

    expect(h.prisma.flashSaleItem.create.mock.calls[0]![0].data.perUserLimit).toBe(1);
  });

  it('refuses a product that is not ACTIVE', async () => {
    h.prisma.product.findFirst.mockResolvedValue(
      product({ status: ProductStatus.ARCHIVED }),
    );

    await expect(
      h.service.nominate(vendor('vendor-1'), 'fs-1', nominateDto()),
    ).rejects.toThrow(/only active products/i);
  });

  it('refuses a variant belonging to another product', async () => {
    h.prisma.productVariant.findUnique.mockResolvedValue({
      id: 'v-9',
      productId: 'other',
      stock: 5,
    });

    await expect(
      h.service.nominate(
        vendor('vendor-1'),
        'fs-1',
        nominateDto({ variantId: 'v-9' }),
      ),
    ).rejects.toThrow(/variant not found/i);
  });

  it('refuses a duplicate nomination', async () => {
    // The unique constraint does not cover NULL variantId, so this is a lookup
    // rather than reliance on P2002.
    h.prisma.flashSaleItem.findFirst.mockResolvedValue({ id: 'existing' });

    await expect(
      h.service.nominate(vendor('vendor-1'), 'fs-1', nominateDto()),
    ).rejects.toThrow(/already nominated/i);
  });
});

describe('FlashSaleService.nominate — sale price validation', () => {
  let h: ReturnType<typeof build>;

  beforeEach(() => {
    h = build();
  });

  it('rejects a price at or above the normal price', async () => {
    // A "flash sale" that sells at the normal price is a mispricing, not a
    // promotion, and would override the tier the customer expects.
    await expect(
      h.service.nominate(vendor('vendor-1'), 'fs-1', nominateDto({ salePrice: '500.00' })),
    ).rejects.toThrow(/must be below the normal price/);
  });

  it('rejects a price above the normal price', async () => {
    await expect(
      h.service.nominate(vendor('vendor-1'), 'fs-1', nominateDto({ salePrice: '900.00' })),
    ).rejects.toThrow(/must be below the normal price/);
  });

  it('rejects a zero or negative price', async () => {
    await expect(
      h.service.nominate(vendor('vendor-1'), 'fs-1', nominateDto({ salePrice: '0' })),
    ).rejects.toThrow(/greater than zero/i);

    await expect(
      h.service.nominate(vendor('vendor-1'), 'fs-1', nominateDto({ salePrice: '-5' })),
    ).rejects.toThrow(/greater than zero/i);
  });

  it('rejects sub-cent precision', async () => {
    await expect(
      h.service.nominate(vendor('vendor-1'), 'fs-1', nominateDto({ salePrice: '299.999' })),
    ).rejects.toThrow(/at most 2 decimal places/i);
  });

  it('rejects a non-numeric price', async () => {
    await expect(
      h.service.nominate(vendor('vendor-1'), 'fs-1', nominateDto({ salePrice: 'cheap' })),
    ).rejects.toThrow(/decimal number/i);
  });

  it('rejects a budget larger than the stock that can fill it', async () => {
    h.prisma.productVariant.findMany.mockResolvedValue([{ stock: 3 }]);

    await expect(
      h.service.nominate(vendor('vendor-1'), 'fs-1', nominateDto({ stockLimit: 50 })),
    ).rejects.toThrow(/exceeds available stock/i);
  });

  it('checks the named variant own stock, not the product total', async () => {
    h.prisma.productVariant.findUnique.mockResolvedValue({
      id: 'v-1',
      productId: 'p1',
      stock: 2,
    });

    await expect(
      h.service.nominate(
        vendor('vendor-1'),
        'fs-1',
        nominateDto({ variantId: 'v-1', stockLimit: 10 }),
      ),
    ).rejects.toThrow(/exceeds available stock/i);
  });
});

describe('FlashSaleService.listActive', () => {
  it('reports remaining budget rather than raw counters', async () => {
    const h = build();
    h.prisma.flashSale.findMany.mockResolvedValue([
      {
        id: 'fs-1',
        title: 'Eid',
        startsAt: new Date('2026-01-01T00:00:00Z'),
        endsAt: new Date('2026-01-02T00:00:00Z'),
        items: [
          {
            id: 'fsi-1',
            productId: 'p1',
            variantId: null,
            salePrice: dec('299.00'),
            stockLimit: 10,
            soldCount: 4,
            perUserLimit: 2,
            product: { name: 'Widget', slug: 'widget', price: dec('500.00'), images: [] },
          },
        ],
      },
    ]);

    const [sale] = await h.service.listActive();

    expect(sale!.items[0]).toMatchObject({
      salePrice: '299.00',
      normalPrice: '500.00',
      remaining: 6,
    });
  });

  it('hides an item that has sold out', async () => {
    const h = build();
    h.prisma.flashSale.findMany.mockResolvedValue([
      {
        id: 'fs-1',
        title: 'Eid',
        startsAt: new Date(),
        endsAt: new Date(),
        items: [
          {
            id: 'fsi-1',
            productId: 'p1',
            variantId: null,
            salePrice: dec('299.00'),
            stockLimit: 5,
            soldCount: 5,
            perUserLimit: 1,
            product: { name: 'Widget', slug: 'widget', price: dec('500.00'), images: [] },
          },
        ],
      },
    ]);

    const [sale] = await h.service.listActive();

    // An exhausted offer must not render as an empty slot.
    expect(sale!.items).toEqual([]);
  });

  it('never reports a negative remaining budget', async () => {
    const h = build();
    h.prisma.flashSale.findMany.mockResolvedValue([
      {
        id: 'fs-1',
        title: 'Eid',
        startsAt: new Date(),
        endsAt: new Date(),
        items: [
          {
            id: 'fsi-1',
            productId: 'p1',
            variantId: null,
            salePrice: dec('299.00'),
            stockLimit: 5,
            soldCount: 9,
            perUserLimit: 1,
            product: { name: 'Widget', slug: 'widget', price: dec('500.00'), images: [] },
          },
        ],
      },
    ]);

    const [sale] = await h.service.listActive();

    expect(sale!.items).toEqual([]);
  });

  it('queries only live, active sales', async () => {
    const h = build();

    await h.service.listActive();

    const where = h.prisma.flashSale.findMany.mock.calls[0]![0].where;
    expect(where.isActive).toBe(true);
    expect(where.startsAt).toEqual({ lte: expect.any(Date) });
    expect(where.endsAt).toEqual({ gte: expect.any(Date) });
  });

  it('caches for 30 seconds', async () => {
    const h = build();

    await h.service.listActive();

    expect(h.cache.set).toHaveBeenCalledWith('flash-sales:active', expect.any(Array), 30);
  });

  it('serves the cached list without querying', async () => {
    const cached = [{ id: 'fs-1', title: 'Eid', startsAt: new Date(), endsAt: new Date(), items: [] }];
    const h = build();
    h.cache.get.mockResolvedValue(cached);

    expect(await h.service.listActive()).toBe(cached);
    expect(h.prisma.flashSale.findMany).not.toHaveBeenCalled();
  });

  it('only resolves approved items', async () => {
    const h = build();
    h.prisma.flashSale.findMany.mockResolvedValue([
      {
        id: 'fs-1',
        title: 'Eid',
        startsAt: new Date(),
        endsAt: new Date(),
        items: [
          {
            id: 'fsi-1',
            productId: 'p1',
            variantId: null,
            salePrice: dec('299.00'),
            stockLimit: 10,
            soldCount: 0,
            perUserLimit: 1,
            product: { name: 'Widget', slug: 'widget', price: dec('500.00'), images: [] },
          },
        ],
      },
    ]);

    await h.service.listActive();

    const where = h.prisma.flashSale.findMany.mock.calls[0]![0].include.items.where;
    expect(where.status).toBe(FlashSaleItemStatus.APPROVED);
  });
});

describe('FlashSaleService — admin writes', () => {
  it('drops the active cache on every write', async () => {
    const h = build();

    await h.service.create({
      title: 'Eid',
      startsAt: '2026-01-01T00:00:00.000Z',
      endsAt: '2026-01-02T00:00:00.000Z',
    } as never);
    await h.service.update('fs-1', { isActive: false } as never);
    await h.service.remove('fs-1');
    await h.service.nominate(vendor('vendor-1'), 'fs-1', nominateDto());

    expect(h.cache.del).toHaveBeenCalledTimes(4);
    expect(h.cache.del).toHaveBeenCalledWith('flash-sales:active');
  });

  it('drops it on moderation and item removal', async () => {
    const h = build();

    h.prisma.flashSaleItem.findUnique.mockResolvedValue({ id: 'fsi-1' } as never);
    await h.service.moderateItem('fsi-1', { status: FlashSaleItemStatus.APPROVED });
    await h.service.removeItem('fsi-1');
    h.prisma.flashSaleItem.findUnique.mockResolvedValue({
      id: 'fsi-1',
      soldCount: 0,
      product: { name: 'Widget', price: dec('500.00') },
    } as never);
    await h.service.updateItem('fsi-1', { salePrice: '199.00' });

    expect(h.cache.del).toHaveBeenCalledTimes(3);
  });

  it('rejects an inverted window on create', async () => {
    const h = build();

    await expect(
      h.service.create({
        title: 'Eid',
        startsAt: '2026-02-01T00:00:00.000Z',
        endsAt: '2026-01-01T00:00:00.000Z',
      } as never),
    ).rejects.toThrow(/startsAt must be before endsAt/);
  });

  it('checks a partial window update against the stored bound', async () => {
    const h = build();
    h.prisma.flashSale.findUnique.mockResolvedValue({
      id: 'fs-1',
      startsAt: null,
      endsAt: new Date('2026-01-01T00:00:00Z'),
      items: [],
    } as never);

    await expect(
      h.service.update('fs-1', { startsAt: '2026-06-01T00:00:00.000Z' } as never),
    ).rejects.toThrow(/startsAt must be before endsAt/);
  });

  it('refuses to drop a budget below what is already sold', async () => {
    const h = build();
    h.prisma.flashSaleItem.findUnique.mockResolvedValue({
      id: 'fsi-1',
      soldCount: 7,
      product: { name: 'Widget', price: dec('500.00') },
    } as never);

    await expect(
      h.service.updateItem('fsi-1', { stockLimit: 3 }),
    ).rejects.toThrow(/cannot be below the 7 unit/);
  });

  it('re-validates the price on a later edit', async () => {
    const h = build();
    h.prisma.flashSaleItem.findUnique.mockResolvedValue({
      id: 'fsi-1',
      soldCount: 0,
      product: { name: 'Widget', price: dec('500.00') },
    } as never);

    // Approving at 299 and later editing to 600 must not slip through.
    await expect(
      h.service.updateItem('fsi-1', { salePrice: '600.00' }),
    ).rejects.toThrow(/must be below the normal price/);
  });

  it('still completes the write when Redis is down', async () => {
    // The 30s TTL self-heals, so a stale listing beats a failed admin save.
    const h = build();
    h.cache.del.mockRejectedValue(new Error('ECONNRESET'));

    await expect(
      h.service.create({
        title: 'Eid',
        startsAt: '2026-01-01T00:00:00.000Z',
        endsAt: '2026-01-02T00:00:00.000Z',
      } as never),
    ).resolves.toBeDefined();
  });
});
