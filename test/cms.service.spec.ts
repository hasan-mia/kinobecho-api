import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BannerLinkType,
  BannerPlacement,
  HomeSectionType,
  Locale,
  Prisma,
} from '@prisma/client';
import {
  CmsService,
  HomePayload,
  HomeSectionView,
  ProductCardView,
} from '../src/modules/cms/cms.service';
import { PrismaService } from '../src/database/prisma.service';
import { RedisCacheService } from '../src/common/cache/redis-cache.service';
import { StorageService } from '../src/modules/storage/storage.service';
import { ProductPricingService } from '../src/modules/product/pricing/product-pricing.service';

const HOME_CACHE_KEY = 'cms:home';
/** The payload is cached per locale, so a key is always the base plus one. */
const homeKey = (locale: Locale = Locale.en) => `${HOME_CACHE_KEY}:${locale}`;

const banner = (overrides: Record<string, unknown> = {}) => ({
  id: 'b1',
  title: 'Eid collection',
  imageUrl: 'http://cdn/eid.webp',
  mobileImageUrl: null,
  linkType: BannerLinkType.NONE,
  linkValue: null,
  placement: BannerPlacement.HOME_HERO,
  sortOrder: 0,
  startsAt: null,
  endsAt: null,
  isActive: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

const product = (overrides: Record<string, unknown> = {}) => ({
  id: '8f2c0000-0000-4000-8000-000000000001',
  name: 'Widget',
  slug: 'widget',
  price: new Prisma.Decimal('250.00'),
  images: [{ thumbUrl: 'http://cdn/t.webp', url: 'http://cdn/l.webp' }],
  variants: [{ stock: 3 }],
  priceTiers: [],
  vendor: { id: 'v1', businessName: 'V', slug: 'v' },
  ...overrides,
});

function build(overrides: Record<string, any> = {}) {
  const prisma = {
    banner: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn().mockImplementation(async ({ data }) => banner(data)),
      update: vi.fn().mockImplementation(async ({ where, data }) =>
        banner({ id: where.id, ...data }),
      ),
      delete: vi.fn().mockResolvedValue(undefined),
      count: vi.fn().mockResolvedValue(0),
    },
    homeSection: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: 's1', ...data })),
      update: vi.fn().mockImplementation(async ({ where, data }) => ({
        id: where.id,
        ...data,
      })),
      delete: vi.fn().mockResolvedValue(undefined),
      count: vi.fn().mockResolvedValue(0),
    },
    product: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    category: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi.fn().mockImplementation(async (arg) =>
      Array.isArray(arg) ? Promise.all(arg) : arg([]),
    ),
    ...overrides.prisma,
  };

  const cache = {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    ...overrides.cache,
  };

  const service = new CmsService(
    prisma as unknown as PrismaService,
    cache as unknown as RedisCacheService,
    { uploadImageVariants: vi.fn() } as unknown as StorageService,
    {
      resolveUnitPrice: vi.fn().mockResolvedValue(new Prisma.Decimal('250.00')),
    } as unknown as ProductPricingService,
  );

  return { service, prisma, cache };
}

describe('CmsService.getHome — date-range filtering', () => {
  it('only asks for active banners inside their scheduling window', async () => {
    const { service, prisma } = build();

    await service.getHome();

    const where = prisma.banner.findMany.mock.calls[0][0].where;

    expect(where.isActive).toBe(true);

    // A null bound means "unbounded", so the window is two OR clauses rather
    // than a negated range Postgres would not index.
    expect(where.AND).toEqual([
      { OR: [{ startsAt: null }, { startsAt: { lte: expect.any(Date) } }] },
      { OR: [{ endsAt: null }, { endsAt: { gte: expect.any(Date) } }] },
    ]);
  });

  it('returns only active sections in sort order', async () => {
    const { service, prisma } = build();

    await service.getHome();

    expect(prisma.homeSection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
    );
  });

  it('serves the cached payload without touching the database', async () => {
    const cached = { banners: [], sections: [] };
    const { service, prisma, cache } = build({ cache: { get: vi.fn().mockResolvedValue(cached) } });

    const result = await service.getHome();

    expect(result).toBe(cached);
    expect(prisma.banner.findMany).not.toHaveBeenCalled();
    expect(prisma.homeSection.findMany).not.toHaveBeenCalled();
  });

  it('caches the resolved payload for two minutes', async () => {
    const { service, cache } = build();

    await service.getHome();

    expect(cache.set).toHaveBeenCalledWith(homeKey(), expect.any(Object), 120);
  });
});

describe('CmsService — cache invalidation on admin writes', () => {
  it('drops the cached home payload when a banner is created', async () => {
    const { service, cache } = build();

    await service.createBanner({
      title: 'Eid collection',
      imageUrl: 'http://cdn/eid.webp',
      placement: BannerPlacement.HOME_HERO,
    } as never);

    expect(cache.del).toHaveBeenCalledWith([homeKey(), homeKey(Locale.bn)]);
  });

  it('drops it when a banner is updated, deleted or reordered', async () => {
    const { service, prisma, cache } = build();

    prisma.banner.findUnique.mockResolvedValue(banner());
    await service.updateBanner('b1', { title: 'New title' } as never);
    await service.removeBanner('b1');

    prisma.banner.findMany.mockResolvedValue([banner()]);
    await service.reorderBanners(BannerPlacement.HOME_HERO, ['b1']);

    expect(cache.del).toHaveBeenCalledTimes(3);
    expect(cache.del).toHaveBeenCalledWith([homeKey(), homeKey(Locale.bn)]);
  });

  it('drops it on every section write', async () => {
    const { service, prisma, cache } = build();

    await service.createSection({
      title: 'Best sellers',
      type: 'PRODUCT_LIST' as never,
      config: { productIds: ['8f2c0000-0000-4000-8000-000000000001'] },
    } as never);

    prisma.homeSection.findUnique.mockResolvedValue({ id: 's1', type: 'PRODUCT_LIST' } as never);
    await service.updateSection('s1', { title: 'Trending' } as never);
    await service.removeSection('s1');

    prisma.homeSection.findMany.mockResolvedValue([{ id: 's1' } as never]);
    await service.reorderSections(['s1']);

    expect(cache.del).toHaveBeenCalledTimes(4);
  });

  it('still completes the write when Redis is down', async () => {
    // A stale home page for one TTL is recoverable; failing an admin's save
    // because the cache blinked is not.
    const { service, prisma, cache } = build();
    prisma.banner.findUnique.mockResolvedValue(banner());
    cache.del.mockRejectedValue(new Error('ECONNRESET'));

    await expect(service.removeBanner('b1')).resolves.toEqual({ deleted: true, id: 'b1' });
    expect(prisma.banner.delete).toHaveBeenCalled();
  });
});

describe('CmsService.createBanner — link validation', () => {
  it('rejects a missing linkValue for a typed link', async () => {
    const { service } = build();

    await expect(
      service.createBanner({
        title: 'Eid',
        imageUrl: 'http://cdn/eid.webp',
        linkType: BannerLinkType.PRODUCT,
        placement: BannerPlacement.HOME_HERO,
      } as never),
    ).rejects.toThrow(/linkValue is required/);
  });

  it('rejects a non-http URL', async () => {
    const { service } = build();

    await expect(
      service.createBanner({
        title: 'Eid',
        imageUrl: 'http://cdn/eid.webp',
        linkType: BannerLinkType.URL,
        linkValue: 'javascript:alert(1)',
        placement: BannerPlacement.HOME_HERO,
      } as never),
    ).rejects.toThrow(/http or https/);
  });

  it('clears linkValue when linkType is NONE', async () => {
    const { service, prisma } = build();

    await service.createBanner({
      title: 'Eid',
      imageUrl: 'http://cdn/eid.webp',
      linkType: BannerLinkType.NONE,
      linkValue: '8f2c0000-0000-4000-8000-000000000001',
      placement: BannerPlacement.HOME_HERO,
    } as never);

    // Otherwise deactivating a link leaves a target the storefront still uses.
    expect(prisma.banner.create.mock.calls[0][0].data.linkValue).toBeNull();
  });

  it('rejects an inverted scheduling window', async () => {
    const { service } = build();

    await expect(
      service.createBanner({
        title: 'Eid',
        imageUrl: 'http://cdn/eid.webp',
        placement: BannerPlacement.HOME_HERO,
        startsAt: '2026-02-01T00:00:00.000Z',
        endsAt: '2026-01-01T00:00:00.000Z',
      } as never),
    ).rejects.toThrow(/startsAt must be before endsAt/);
  });
});

describe('CmsService.updateBanner — partial updates merge with the stored row', () => {
  it('validates a linkType switch against the value already stored', async () => {
    const { service, prisma } = build();

    // Stored as a PRODUCT link, then switched to URL with no new linkValue.
    prisma.banner.findUnique.mockResolvedValue(
      banner({ linkType: BannerLinkType.PRODUCT, linkValue: '11111111-1111-4111-8111-111111111111' }),
    );

    await expect(
      service.updateBanner('b1', { linkType: BannerLinkType.URL } as never),
    ).rejects.toThrow(/linkValue must be a valid absolute URL/);
    expect(prisma.banner.update).not.toHaveBeenCalled();
  });

  it('clears the link when switching to NONE without a linkValue', async () => {
    const { service, prisma } = build();

    prisma.banner.findUnique.mockResolvedValue(
      banner({ linkType: BannerLinkType.URL, linkValue: 'https://example.com' }),
    );

    await service.updateBanner('b1', { linkType: BannerLinkType.NONE } as never);

    expect(prisma.banner.update.mock.calls[0][0].data.linkValue).toBeNull();
  });

  it('leaves the link untouched when the payload says nothing about it', async () => {
    const { service, prisma } = build();

    prisma.banner.findUnique.mockResolvedValue(
      banner({ linkType: BannerLinkType.URL, linkValue: 'https://example.com' }),
    );

    await service.updateBanner('b1', { title: 'New title' } as never);

    expect(prisma.banner.update.mock.calls[0][0].data.linkValue).toBeUndefined();
  });

  it('checks the window against the stored bound when only one side is sent', async () => {
    const { service, prisma } = build();

    // Stored window ends 2026-01-01; a start after that would invert it.
    prisma.banner.findUnique.mockResolvedValue(
      banner({
        startsAt: null,
        endsAt: new Date('2026-01-01T00:00:00Z'),
      }),
    );

    await expect(
      service.updateBanner('b1', { startsAt: '2026-06-01T00:00:00.000Z' } as never),
    ).rejects.toThrow(/startsAt must be before endsAt/);
  });
});

describe('CmsService — section config validation', () => {
  it('reads the id key that matches the section type', async () => {
    const { service, prisma } = build();

    await service.createSection({
      title: 'Top categories',
      type: 'CATEGORY_LIST' as never,
      config: { categoryIds: ['11111111-1111-4111-8111-111111111111'] },
    } as never);

    expect(prisma.homeSection.create.mock.calls[0][0].data.config).toEqual({
      categoryIds: ['11111111-1111-4111-8111-111111111111'],
    });
  });

  it('rejects a config whose ids are not ids', async () => {
    const { service } = build();

    await expect(
      service.createSection({
        title: 'Best sellers',
        type: 'PRODUCT_LIST' as never,
        config: { productIds: ['not-a-uuid'] },
      } as never),
    ).rejects.toThrow(/only id strings/);
  });

  it('rejects a section larger than the cached home payload can carry', async () => {
    const { service } = build();
    const ids = Array.from(
      { length: 51 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );

    await expect(
      service.createSection({
        title: 'Everything',
        type: 'PRODUCT_LIST' as never,
        config: { productIds: ids },
      } as never),
    ).rejects.toThrow(/at most 50 ids/);
  });

  it('rejects a flash-sale window that does not parse', async () => {
    const { service } = build();

    await expect(
      service.createSection({
        title: 'Flash sale',
        type: 'FLASH_SALE' as never,
        config: {
          productIds: ['11111111-1111-4111-8111-111111111111'],
          endsAt: 'soon',
        },
      } as never),
    ).rejects.toThrow(/ISO-8601/);
  });
});

describe('CmsService.getHome — section resolution', () => {
  it('resolves product ids into cards in the configured order', async () => {
    const a = product({ id: '11111111-1111-4111-8111-111111111111', slug: 'a', name: 'A' });
    const b = product({ id: '22222222-2222-4222-8222-222222222222', slug: 'b', name: 'B' });

    const { service, prisma } = build({
      prisma: {
        product: { findMany: vi.fn().mockResolvedValue([b, a]) },
      },
    });

    prisma.homeSection.findMany.mockResolvedValue([
      {
        id: 's1',
        title: 'Best sellers',
        type: 'PRODUCT_LIST',
        sortOrder: 0,
        config: {
          productIds: [
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
          ],
        },
      },
    ]);

    const home = await service.getHome();
    const cards = productCards(firstSectionOfType(home, HomeSectionType.PRODUCT_LIST));

    // Database order is arbitrary; section order is the display order.
    expect(cards.map((p) => p.slug)).toEqual(['a', 'b']);

    const [first] = cards;
    expect(first).toMatchObject({ price: '250.00', inStock: true });
  });

  it('drops products that are no longer active', async () => {
    const { service, prisma } = build();

    prisma.homeSection.findMany.mockResolvedValue([
      {
        id: 's1',
        title: 'Best sellers',
        type: 'PRODUCT_LIST',
        sortOrder: 0,
        config: {
          productIds: [
            '11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222',
          ],
        },
      },
    ]);

    // The database returns nothing, so both referenced products were archived.
    const home = await service.getHome();

    expect(prisma.product.findMany.mock.calls[0][0].where).toMatchObject({
      deletedAt: null,
      status: 'ACTIVE',
    });
    expect(productCards(firstSectionOfType(home, HomeSectionType.PRODUCT_LIST))).toEqual([]);
  });

  it('only resolves banners in a section that are live right now', async () => {
    const { service, prisma } = build({
      prisma: {
        banner: {
          findMany: vi.fn().mockResolvedValue([]),
          count: vi.fn().mockResolvedValue(0),
        },
        homeSection: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 's1',
              title: 'Promo',
              type: 'BANNER',
              sortOrder: 0,
              config: { bannerIds: ['22222222-2222-4222-8222-222222222222'] },
            },
          ]),
          count: vi.fn().mockResolvedValue(1),
        },
      },
    });

    const home = await service.getHome();

    // Call 0 is the top-level banner payload; call 1 is the BANNER section's.
    const where = prisma.banner.findMany.mock.calls[1][0].where;
    expect(where.isActive).toBe(true);
    expect(where.OR).toEqual([{ startsAt: null }, { startsAt: { lte: expect.any(Date) } }]);
    expect(where.AND).toEqual([
      { OR: [{ endsAt: null }, { endsAt: { gte: expect.any(Date) } }] },
    ]);
    expect(firstSectionOfType(home, HomeSectionType.BANNER).banners).toEqual([]);
  });
});

describe('CmsService — reorder', () => {
  it('assigns sequential sort orders', async () => {
    const { service, prisma } = build();

    prisma.banner.findMany.mockResolvedValue([
      banner({ id: 'b1' }),
      banner({ id: 'b2' }),
      banner({ id: 'b3' }),
    ]);

    await service.reorderBanners(BannerPlacement.HOME_HERO, ['b3', 'b1', 'b2']);

    expect(prisma.banner.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'b3' },
      data: { sortOrder: 0 },
    });
    expect(prisma.banner.update).toHaveBeenNthCalledWith(3, {
      where: { id: 'b2' },
      data: { sortOrder: 2 },
    });
  });

  it('appends ids the client omitted so no row keeps a stale index', async () => {
    const { service, prisma } = build();

    prisma.banner.findMany.mockResolvedValue([
      banner({ id: 'b1' }),
      banner({ id: 'b2' }),
    ]);

    await service.reorderBanners(BannerPlacement.HOME_HERO, ['b2']);

    expect(prisma.banner.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'b1' },
      data: { sortOrder: 1 },
    });
  });

  it('rejects ids that are not in the target placement', async () => {
    const { service, prisma } = build();

    prisma.banner.findMany.mockResolvedValue([banner({ id: 'b1' })]);

    await expect(
      service.reorderBanners(BannerPlacement.HOME_HERO, [
        '99999999-9999-4999-8999-999999999999',
      ]),
    ).rejects.toThrow(/not in the target placement/);

    expect(prisma.banner.update).not.toHaveBeenCalled();
  });
});

describe('CmsService.uploadBannerImage', () => {
  function withStorage(uploadImageVariants: ReturnType<typeof vi.fn>) {
    return new CmsService(
      {} as never,
      {} as never,
      { uploadImageVariants } as unknown as StorageService,
      {} as never,
    );
  }

  it('routes the creative through the shared resize pipeline', async () => {
    const uploadImageVariants = vi.fn().mockResolvedValue({
      url: 'http://cdn/l.webp',
      mediumUrl: 'http://cdn/m.webp',
      thumbUrl: 'http://cdn/t.webp',
      width: 1200,
      height: 600,
    });

    const file = { buffer: Buffer.from('x'), mimetype: 'image/webp' } as Express.Multer.File;

    const result = await withStorage(uploadImageVariants).uploadBannerImage(
      file,
      'imageUrl',
      'b1',
      'u1',
    );

    expect(uploadImageVariants).toHaveBeenCalledWith(file, {
      ownerType: 'BANNER_IMAGE',
      ownerId: 'b1',
      uploadedById: 'u1',
    });
    expect(result).toMatchObject({ target: 'imageUrl', url: 'http://cdn/l.webp' });
  });

  it('rejects a request with no file', async () => {
    const uploadImageVariants = vi.fn();

    await expect(
      withStorage(uploadImageVariants).uploadBannerImage(
        undefined as never,
        'imageUrl',
      ),
    ).rejects.toThrow(/No file provided/);
    expect(uploadImageVariants).not.toHaveBeenCalled();
  });
});

/**
 * Asserts the resolved payload actually contains the section type under test,
 * so a resolver that stopped emitting it fails loudly instead of silently
 * skipping the assertions that follow.
 */
function firstSectionOfType<T extends HomeSectionType>(
  home: HomePayload,
  type: T,
): HomeSectionView {
  const section = home.sections.find((s) => s.type === type);

  if (!section) {
    throw new Error(`No ${type} section in the resolved payload`);
  }

  return section;
}

/**
 * Reads the resolved cards off a product section, failing if the resolver
 * omitted them rather than letting a `.map` on undefined pass silently.
 */
function productCards(section: HomeSectionView): ProductCardView[] {
  if (!section.products) {
    throw new Error(`Section ${section.id} resolved without products`);
  }

  return section.products;
}
