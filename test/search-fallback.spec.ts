import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma, ProductStatus, SaleType } from '@prisma/client';
import { SearchService } from '../src/modules/search/search.service';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/database/prisma.service';
import { RedisCacheService } from '../src/common/cache/redis-cache.service';

const dec = (v: string) => new Prisma.Decimal(v);

const productRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'p2',
  name: 'Phone',
  slug: 'phone',
  price: dec('100'),
  ratingAvg: dec('4.50'),
  ratingCount: 10,
  soldCount: 5,
  saleType: SaleType.RETAIL,
  images: [{ thumbUrl: 'http://cdn/thumb.webp' }],
  vendor: { id: 'v1', businessName: 'V', slug: 'v', logoUrl: null },
  category: { id: 'c1', name: 'C', slug: 'c' },
  brand: { id: 'b1', name: 'B', slug: 'b', logoUrl: null },
  _count: { variants: 1 },
  ...overrides,
});

describe('SearchService — Meilisearch unavailable', () => {
  let prisma: any;
  let client: any;
  let service: SearchService;
  let enabled: boolean;

  const build = () => {
    prisma = {
      product: {
        findMany: vi.fn().mockResolvedValue([productRow()]),
        count: vi.fn().mockResolvedValue(1),
        groupBy: vi.fn().mockResolvedValue([]),
        aggregate: vi
          .fn()
          .mockResolvedValue({ _min: { price: dec('100') }, _max: { price: dec('100') } }),
      },
      category: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
      brand: { findMany: vi.fn().mockResolvedValue([]) },
    };

    prisma.$transaction = vi.fn((args: unknown) =>
      Array.isArray(args)
        ? Promise.all(args)
        : (args as (client: unknown) => unknown)(prisma),
    );

    client = {
      index: vi.fn().mockReturnValue({
        search: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')),
        deleteDocument: vi.fn().mockResolvedValue({ taskUid: 1 }),
        addDocuments: vi.fn().mockResolvedValue({ taskUid: 1 }),
        deleteAllDocuments: vi.fn().mockResolvedValue({ taskUid: 1 }),
        updateSettings: vi.fn().mockResolvedValue({ taskUid: 1 }),
      }),
      tasks: { waitForTask: vi.fn().mockResolvedValue({ status: 'succeeded' }) },
      health: vi.fn().mockRejectedValue(new Error('down')),
    };

    service = new SearchService(
      prisma as unknown as PrismaService,
      {
        get: (key: string) =>
          key === 'search.enabled' ? enabled : key === 'search.index' ? 'products' : undefined,
      } as unknown as ConfigService,
      { get: vi.fn(), set: vi.fn() } as unknown as RedisCacheService,
      client as never,
    );
  };

  beforeEach(() => {
    enabled = true;
    build();
  });

  it('falls back to Postgres when the engine throws', async () => {
    const result = await service.searchProducts({ q: 'phone' });

    expect(result.engine).toBe('postgres');
    expect(result.items).toHaveLength(1);
    expect(prisma.product.findMany).toHaveBeenCalled();
  });

  it('returns the same envelope the indexed path returns', async () => {
    const result = await service.searchProducts({ q: 'phone', page: 2, limit: 10 });

    expect(result.meta).toEqual({ total: 1, page: 2, limit: 10, totalPages: 1 });
    expect(result.facets).toHaveProperty('brands');
    expect(result.facets).toHaveProperty('categories');
    expect(result.facets).toHaveProperty('priceRange');
  });

  it('never touches the engine at all when search is disabled', async () => {
    enabled = false;

    const result = await service.searchProducts({ q: 'phone' });

    expect(result.engine).toBe('postgres');
    expect(client.index).not.toHaveBeenCalled();
  });

  it('matches case-insensitively on name, like the ILIKE path always did', async () => {
    await service.searchProducts({ q: 'PHONE' });

    const where = prisma.product.findMany.mock.calls[0]![0].where as {
      OR: { name: unknown }[];
    };

    expect(where.OR[0]?.name).toEqual({
      contains: 'PHONE',
      mode: 'insensitive',
    });
  });

  it('also searches description and brand name, which the index searches too', async () => {
    await service.searchProducts({ q: 'blue' });

    const where = prisma.product.findMany.mock.calls[0]![0].where as {
      OR: Record<string, unknown>[];
    };

    // Asserted by content rather than by index: the OR list grows whenever the
    // fallback needs to match something new, and an index-based assertion would
    // break for a reason that has nothing to do with this test.
    expect(where.OR).toContainEqual({
      description: { contains: 'blue', mode: 'insensitive' },
    });
    expect(where.OR).toContainEqual({
      name: { contains: 'blue', mode: 'insensitive' },
    });
  });

  it('searches translations, so a Bengali query works without the index', async () => {
    await service.searchProducts({ q: 'মোবাইল' });

    const where = prisma.product.findMany.mock.calls[0]![0].where as {
      OR: Record<string, unknown>[];
    };

    // Parity with the Meilisearch path matters more than the extra predicate: a
    // fallback that quietly searched less would look like products vanishing
    // whenever the index happened to be down.
    expect(JSON.stringify(where.OR)).toContain('translations');
  });

  it('applies the same filters on the fallback path', async () => {
    await service.searchProducts({
      q: 'x',
      brandId: 'b1',
      vendorId: 'v1',
      saleType: SaleType.WHOLESALE,
      minPrice: 50,
      maxPrice: 500,
      minRating: 4,
    });

    const where = prisma.product.findMany.mock.calls[0]![0].where;

    expect(where.brandId).toBe('b1');
    expect(where.vendorId).toBe('v1');
    expect(where.saleType).toBe(SaleType.WHOLESALE);
    expect(where.price.gte.toString()).toBe('50');
    expect(where.price.lte.toString()).toBe('500');
    expect(where.ratingAvg.gte.toString()).toBe('4');
    expect(where.status).toBe(ProductStatus.ACTIVE);
    expect(where.deletedAt).toBeNull();
  });

  it('honours the requested sort on the fallback path', async () => {
    await service.searchProducts({ sort: 'price_asc' as never });

    const orderBy = prisma.product.findMany.mock.calls[0]![0].orderBy as Record<string, string>[];

    expect(orderBy[0]).toEqual({ price: 'asc' });
  });

  it('adds a stable tiebreaker so paging cannot repeat or skip a row', async () => {
    await service.searchProducts({ sort: 'price_asc' as never });

    const orderBy = prisma.product.findMany.mock.calls[0]![0].orderBy as Record<string, string>[];

    expect(orderBy[orderBy.length - 1]).toEqual({ id: 'asc' });
  });

  it('reports money as strings even on the fallback path', async () => {
    const result = await service.searchProducts({ q: 'phone' });
    const [hit] = result.items;

    expect(hit?.price).toBe('100.00');
    expect(hit?.ratingAvg).toBe('4.50');
  });

  it('falls back for suggestions too', async () => {
    const result = await service.suggest('pho');

    expect(result.engine).toBe('postgres');
    expect(result.suggestions).toHaveLength(1);
  });
});

describe('SearchService — engine available', () => {
  let prisma: any;
  let index: any;
  let service: SearchService;

  beforeEach(() => {
    prisma = {
      product: { findMany: vi.fn().mockResolvedValue([productRow()]) },
      category: { findMany: vi.fn().mockResolvedValue([]) },
      brand: {
        findMany: vi.fn().mockResolvedValue([{ id: 'b1', name: 'Brand One' }]),
      },
    };

    index = {
      search: vi.fn().mockResolvedValue({
        hits: [{ id: 'p2' }, { id: 'p1' }],
        estimatedTotalHits: 2,
        facetDistribution: {
          brandId: { b1: 2 },
          categoryIds: { c1: 2 },
          price: { 100: 2 },
        },
      }),
      addDocuments: vi.fn().mockResolvedValue({ taskUid: 1 }),
      deleteDocument: vi.fn().mockResolvedValue({ taskUid: 1 }),
      updateSettings: vi.fn().mockResolvedValue({ taskUid: 1 }),
    };

    const client = {
      index: vi.fn().mockReturnValue(index),
      tasks: { waitForTask: vi.fn().mockResolvedValue({ status: 'succeeded' }) },
    };

    service = new SearchService(
      prisma as unknown as PrismaService,
      {
        get: (key: string) =>
          key === 'search.enabled' ? true : key === 'search.index' ? 'products' : undefined,
      } as unknown as ConfigService,
      { get: vi.fn(), set: vi.fn() } as unknown as RedisCacheService,
      client as never,
    );
  });

  it('reports the engine it used', async () => {
    const result = await service.searchProducts({ q: 'phone' });

    expect(result.engine).toBe('meilisearch');
  });

  it('always filters to ACTIVE products, even for an empty query', async () => {
    await service.searchProducts({});

    expect(index.search.mock.calls[0]![1].filter).toEqual(['status = ACTIVE']);
  });

  it('quotes filter values so an id is not read as a field reference', async () => {
    await service.searchProducts({ categoryId: 'c1', brandId: 'b1' });

    expect(index.search.mock.calls[0]![1].filter).toEqual([
      'status = ACTIVE',
      'categoryIds = "c1"',
      'brandId = "b1"',
    ]);
  });

  it('sends no sort for relevance, so the engine ranks', async () => {
    await service.searchProducts({ q: 'a', sort: 'relevance' as never });

    expect(index.search.mock.calls[0]![1].sort).toBeUndefined();
  });

  it('maps every sort to an index field', async () => {
    const cases: [string, string][] = [
      ['price_asc', 'price:asc'],
      ['price_desc', 'price:desc'],
      ['newest', 'createdAt:desc'],
      ['popular', 'soldCount:desc'],
      ['rating', 'ratingAvg:desc'],
    ];

    for (const [sort, expected] of cases) {
      await service.searchProducts({ q: 'a', sort: sort as never });
      // The mock accumulates calls across the loop; the last one is this case.
      const call = index.search.mock.calls.at(-1)![1];
      expect(call.sort).toEqual([expected]);
    }
  });

  it('re-orders the hydrated rows to match the engine ranking', async () => {
    prisma.product.findMany.mockResolvedValue([
      productRow({ id: 'p1', name: 'First' }),
      productRow({ id: 'p2', name: 'Second' }),
    ]);

    const result = await service.searchProducts({ q: 'a' });

    // The engine said p2 first; Postgres returned p1 first. The engine wins.
    expect(result.items.map((item) => item.id)).toEqual(['p2', 'p1']);
  });

  it('drops ids the engine returned but Postgres no longer has', async () => {
    prisma.product.findMany.mockResolvedValue([productRow({ id: 'p2' })]);

    const result = await service.searchProducts({ q: 'a' });

    expect(result.items.map((item) => item.id)).toEqual(['p2']);
  });

  it('reads money from Postgres, so a float index cannot round it wrong', async () => {
    prisma.product.findMany.mockResolvedValue([
      productRow({ price: dec('79.99'), ratingAvg: dec('4.50') }),
    ]);

    const result = await service.searchProducts({ q: 'a' });
    const [hit] = result.items;

    expect(hit?.price).toBe('79.99');
    expect(hit?.ratingAvg).toBe('4.50');
  });

  it('turns facet ids into names', async () => {
    const result = await service.searchProducts({ q: 'a' });

    expect(result.facets.brands).toEqual([{ id: 'b1', name: 'Brand One', count: 2 }]);
    expect(result.facets.priceRange).toEqual({ min: 100, max: 100 });
  });

  it('requests only the ids it needs from the engine', async () => {
    await service.searchProducts({ q: 'a' });

    expect(index.search.mock.calls[0]![1].attributesToRetrieve).toEqual(['id']);
  });
});
