import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { ListProductsQueryDto } from '../src/modules/product/dto/product.dto';
import {
  SearchProductsQueryDto,
  SuggestQueryDto,
} from '../src/modules/search/dto/search.dto';
import { ListWishlistQueryDto } from '../src/modules/wishlist/dto/wishlist.dto';
import { Locale, Prisma, ProductStatus, SaleType, UserRole } from '@prisma/client';
import { ProductService } from '../src/modules/product/product.service';
import { CategoryService } from '../src/modules/category/category.service';
import { BrandService } from '../src/modules/brand/brand.service';
import { PrismaService } from '../src/database/prisma.service';
import { RedisCacheService } from '../src/common/cache/redis-cache.service';
import { SearchSyncService } from '../src/modules/search/search-sync.service';
import { ProductPricingService } from '../src/modules/product/pricing/product-pricing.service';

const dec = (v: string) => new Prisma.Decimal(v);

/**
 * Reads the single element these fixtures always contain. Typed as
 * `T | undefined` on purpose so an empty result fails an assertion instead of
 * throwing a TypeError the test runner reports as an unrelated error.
 */
const first = <T>(rows: T[]): T | undefined => rows[0];

const vendorUser = {
  id: 'vendor-user',
  role: UserRole.VENDOR,
  vendor: { id: 'vendor-1', slug: 'v', businessName: 'V', status: 'ACTIVE' },
} as never;

const productRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'Widget',
  slug: 'widget',
  description: 'A widget',
  price: dec('500.00'),
  status: ProductStatus.ACTIVE,
  saleType: SaleType.RETAIL,
  minOrderQty: null,
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  images: [],
  category: { id: 'c1', name: 'Tools', slug: 'tools', translations: [] },
  brand: { id: 'b1', name: 'Acme', slug: 'acme', logoUrl: null, translations: [] },
  ...overrides,
});

const categoryRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  name: 'Tools',
  slug: 'tools',
  imageUrl: null,
  sortOrder: 0,
  isActive: true,
  parentId: null,
  translations: [],
  ...overrides,
});

function buildProducts(items: unknown[] = [productRow()]) {
  const prisma: Record<string, unknown> = {
    product: {
      findMany: vi.fn().mockResolvedValue(items),
      count: vi.fn().mockResolvedValue(items.length),
      findFirst: vi.fn().mockResolvedValue(items[0]),
    },
    vendor: { findUnique: vi.fn().mockResolvedValue({ id: 'vendor-1', status: 'ACTIVE' }) },
    $transaction: vi.fn((args: unknown) =>
      Array.isArray(args) ? Promise.all(args) : args,
    ),
  };

  const service = new ProductService(
    prisma as unknown as PrismaService,
    { resolveUnitPrice: vi.fn() } as unknown as ProductPricingService,
    { enqueueUpsert: vi.fn() } as unknown as SearchSyncService,
  );

  return { service, prisma };
}

function buildCategories(rows: unknown[] = [categoryRow()]) {
  const prisma = {
    category: { findMany: vi.fn().mockResolvedValue(rows) },
  };

  const cache = {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
  };

  return {
    cache,
    service: new CategoryService(
      prisma as unknown as PrismaService,
      cache as unknown as RedisCacheService,
    ),
  };
}

describe('ProductService.findAll — translated product cards', () => {
  it('returns the Bengali name for a Bengali request', async () => {
    const { service } = buildProducts([
      productRow({ translations: [{ locale: Locale.bn, name: 'উইজেট', description: 'একটি উইজেট' }] }),
    ]);

    const result = await service.findAll({} as never, Locale.bn);
    const [item] = result.items as Array<{ name: string; description: string | null }>;

    expect(item?.name).toBe('উইজেট');
    expect(item?.description).toBe('একটি উইজেট');
  });

  it('falls back to English when the product has no translation', async () => {
    const { service } = buildProducts([productRow({ translations: [] })]);

    const result = await service.findAll({} as never, Locale.bn);
    const [item] = result.items as Array<{ name: string }>;

    // The case that matters: a Bengali shopper must still get a name.
    expect(item?.name).toBe('Widget');
  });

  it('falls back to English when the product is not translated at all in the DB', async () => {
    const { service } = buildProducts([productRow()]);

    const result = await service.findAll({} as never, Locale.bn);
    const [item] = result.items as Array<{ name: string }>;

    expect(item?.name).toBe('Widget');
  });

  it('defaults to English with no locale argument', async () => {
    const { service } = buildProducts([
      productRow({ translations: [{ locale: Locale.bn, name: 'উইজেট' }] }),
    ]);

    const result = await service.findAll({} as never);

    expect(first(result.items)?.name).toBe('Widget');
  });

  it('translates the nested category and brand too', async () => {
    const { service } = buildProducts([
      productRow({
        category: {
          id: 'c1',
          name: 'Tools',
          slug: 'tools',
          translations: [{ locale: Locale.bn, name: 'টুলস' }],
        },
        brand: {
          id: 'b1',
          name: 'Acme',
          slug: 'acme',
          logoUrl: null,
          translations: [{ locale: Locale.bn, name: 'অ্যাকমে' }],
        },
      }),
    ]);

    const result = await service.findAll({} as never, Locale.bn);
    const [item] = result.items as Array<{
      category: { name: string };
      brand: { name: string } | null;
    }>;

    expect(item?.category.name).toBe('টুলস');
    expect(item?.brand?.name).toBe('অ্যাকমে');
  });

  it('leaves slugs alone so a link works in every locale', async () => {
    const { service } = buildProducts([
      productRow({
        slug: 'sony-bravia-55',
        translations: [{ locale: Locale.bn, name: 'সনি ব্রাভিয়া' }],
      }),
    ]);

    const result = await service.findAll({} as never, Locale.bn);

    expect(first(result.items)?.slug).toBe('sony-bravia-55');
  });

  it('keeps the pagination envelope intact', async () => {
    const { service } = buildProducts();

    const result = await service.findAll({ page: 2, limit: 5 } as never, Locale.bn);

    expect(result.meta).toEqual({ total: 1, page: 2, limit: 5, totalPages: 1 });
  });
});

describe('CategoryService.getTree — locale-scoped cache', () => {
  it('caches per locale rather than once', async () => {
    const { service, cache } = buildCategories();

    await service.getTree(false, Locale.bn);

    // A single key would let the first Bengali request pin Bengali names in the
    // entry every English visitor then reads.
    expect(cache.set).toHaveBeenCalledWith(
      'category:tree:bn:active',
      expect.any(Array),
      expect.any(Number),
    );
  });

  it('uses a different key for the admin view', async () => {
    const { service, cache } = buildCategories();

    await service.getTree(true, Locale.bn);

    expect(cache.set).toHaveBeenCalledWith(
      'category:tree:bn:all',
      expect.any(Array),
      expect.any(Number),
    );
  });

  it('translates node names', async () => {
    const { service } = buildCategories([
      categoryRow({ translations: [{ locale: Locale.bn, name: 'টুলস' }] }),
    ]);

    const tree = await service.getTree(false, Locale.bn);

    expect(first(tree)?.name).toBe('টুলস');
  });

  it('falls back to English for an untranslated category', async () => {
    const { service } = buildCategories([categoryRow({ translations: [] })]);

    const tree = await service.getTree(false, Locale.bn);

    expect(first(tree)?.name).toBe('Tools');
  });

  it('serves the cached tree for the requested locale only', async () => {
    const { service, cache } = buildCategories();
    cache.get.mockImplementation((key: string) =>
      Promise.resolve(key === 'category:tree:bn:active' ? [] : undefined),
    );

    await service.getTree(false, Locale.bn);
    await service.getTree(false, Locale.en);

    expect(cache.get).toHaveBeenNthCalledWith(1, 'category:tree:bn:active');
    expect(cache.get).toHaveBeenNthCalledWith(2, 'category:tree:en:active');
  });
});

describe('BrandService — translated names', () => {
  function buildBrands() {
    const prisma = {
      brand: { findMany: vi.fn().mockResolvedValue([]) },
    };

    return {
      prisma,
      service: new BrandService(
        prisma as unknown as PrismaService,
        { enqueueUpsert: vi.fn() } as unknown as SearchSyncService,
      ),
    };
  }

  it('translates the brand list', async () => {
    const { service, prisma } = buildBrands();
    prisma.brand.findMany.mockResolvedValue([
      { id: 'b1', name: 'Samsung', slug: 'samsung', translations: [{ locale: Locale.bn, name: 'স্যামসাং' }] },
    ]);

    const brands = await service.list({}, Locale.bn);

    expect(first(brands)?.name).toBe('স্যামসাং');
  });

  it('falls back to English for an untranslated brand', async () => {
    const { service, prisma } = buildBrands();
    prisma.brand.findMany.mockResolvedValue([
      { id: 'b1', name: 'Samsung', slug: 'samsung', translations: [] },
    ]);

    const brands = await service.list({}, Locale.bn);

    expect(first(brands)?.name).toBe('Samsung');
  });

  it('returns English by default', async () => {
    const { service, prisma } = buildBrands();
    prisma.brand.findMany.mockResolvedValue([
      { id: 'b1', name: 'Samsung', slug: 'samsung', translations: [{ locale: Locale.bn, name: 'স্যামসাং' }] },
    ]);

    const brands = await service.list({});

    expect(first(brands)?.name).toBe('Samsung');
  });
});

describe('query DTOs accept ?lang=', () => {
  // These routes are the exact ones the ValidationPipe rejected with a 422
  // ("property lang should not exist") because the global pipe runs with
  // forbidNonWhitelisted. Calling the service directly cannot catch that, since
  // the pipe never runs — so these validate through the same pipe options
  // main.ts configures, in isolation from the database.
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    errorHttpStatusCode: 422,
  });

  // `extra` supplies whatever else the DTO legitimately requires, so a failure
  // here always means `lang` was rejected rather than an unrelated missing field.
  const validate = async (
    cls: new () => object,
    query: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => {
    const metadata = { type: 'query' as const, metatype: cls };
    return pipe.transform({ ...extra, ...query }, metadata);
  };

  // `q` is required on SuggestQueryDto, so it travels with the class.
  const withRequired = (cls: new () => object) =>
    cls === SuggestQueryDto ? { q: 'phone' } : {};

  it.each([
    ['ListProductsQueryDto', ListProductsQueryDto],
    ['SearchProductsQueryDto', SearchProductsQueryDto],
    ['SuggestQueryDto', SuggestQueryDto],
    ['ListWishlistQueryDto', ListWishlistQueryDto],
  ])('%s accepts a supported lang', async (_name, cls) => {
    await expect(validate(cls, { lang: 'bn' }, withRequired(cls))).resolves.toBeDefined();
  });

  it.each([
    ['ListProductsQueryDto', ListProductsQueryDto],
    ['SearchProductsQueryDto', SearchProductsQueryDto],
    ['SuggestQueryDto', SuggestQueryDto],
    ['ListWishlistQueryDto', ListWishlistQueryDto],
  ])('%s accepts an unsupported lang so it can fall through', async (_name, cls) => {
    // An unrenderable locale must degrade to the header, not 422 the request.
    await expect(validate(cls, { lang: 'fr' }, withRequired(cls))).resolves.toBeDefined();
  });

  it.each([
    ['ListProductsQueryDto', ListProductsQueryDto],
    ['SearchProductsQueryDto', SearchProductsQueryDto],
    ['SuggestQueryDto', SuggestQueryDto],
    ['ListWishlistQueryDto', ListWishlistQueryDto],
  ])('%s still works with no lang at all', async (_name, cls) => {
    await expect(validate(cls, {}, withRequired(cls))).resolves.toBeDefined();
  });

  it('still rejects a genuinely unknown parameter', async () => {
    // Widening the DTO for `lang` must not have disabled validation entirely.
    await expect(
      validate(ListProductsQueryDto, { lang: 'bn', nonsense: 'x' }),
    ).rejects.toThrow();
  });

  it('keeps validating lang as a bounded string', async () => {
    await expect(validate(ListProductsQueryDto, { lang: 42 })).rejects.toThrow();
    await expect(
      validate(ListProductsQueryDto, { lang: 'x'.repeat(200) }),
    ).rejects.toThrow();
  });

  it('still enforces the other filters alongside lang', async () => {
    await expect(
      validate(ListProductsQueryDto, { lang: 'bn', limit: 1000 }),
    ).rejects.toThrow();
  });
});
