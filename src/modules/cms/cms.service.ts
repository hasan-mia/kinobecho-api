import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  BannerLinkType,
  BannerPlacement,
  HomeSectionType,
  Prisma,
  ProductStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { StorageService } from '../storage/storage.service';
import { ProductPricingService } from '../product/pricing/product-pricing.service';
import {
  CreateBannerDto,
  CreateSectionDto,
  ListBannersQueryDto,
  UpdateBannerDto,
  UpdateSectionDto,
} from './dto/cms.dto';

const HOME_CACHE_KEY = 'cms:home';
const HOME_CACHE_TTL = 120;

/** Ids referenced by a section config, so one query can resolve every card. */
const PRODUCT_CARD_INCLUDE = {
  images: {
    where: { isPrimary: true },
    take: 1,
    select: { thumbUrl: true, url: true },
  },
  variants: { select: { stock: true } },
  priceTiers: {
    orderBy: { minQty: 'asc' },
    select: { minQty: true, maxQty: true, unitPrice: true },
  },
  vendor: { select: { id: true, businessName: true, slug: true } },
} satisfies Prisma.ProductInclude;

type ProductCardRow = Prisma.ProductGetPayload<{
  include: typeof PRODUCT_CARD_INCLUDE;
}>;

/** One banner as the storefront receives it. */
export interface BannerView {
  id: string;
  title: string;
  imageUrl: string;
  mobileImageUrl: string | null;
  linkType: BannerLinkType;
  linkValue: string | null;
  placement: BannerPlacement;
  sortOrder: number;
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;
}

/**
 * One shape for every section type. `products`, `categories` and `banners` are
 * all optional because the resolver fills in only the one the section's type
 * reads; a consumer switches on `type`, which is always present.
 */
export interface HomeSectionView {
  id: string;
  title: string;
  type: HomeSectionType;
  sortOrder: number;
  /** PRODUCT_LIST, FLASH_SALE */
  products?: ProductCardView[];
  /** CATEGORY_LIST */
  categories?: Array<{
    id: string;
    name: string;
    slug: string;
    imageUrl: string | null;
  }>;
  /** BANNER */
  banners?: BannerView[];
  /** FLASH_SALE countdown target, when one was configured */
  endsAt?: string | null;
}

export interface HomePayload {
  banners: BannerView[];
  sections: HomeSectionView[];
}

export interface ProductCardView {
  id: string;
  name: string;
  slug: string;
  price: string;
  inStock: boolean;
  thumbUrl: string | null;
  vendor: { id: string; businessName: string; slug: string } | null;
}

/**
 * How many ids a single section may reference. The home payload is cached and
 * served on every storefront visit, so an unbounded list would let one admin
 * entry blow up every home response.
 */
const MAX_SECTION_ITEMS = 50;

@Injectable()
export class CmsService {
  private readonly logger = new Logger(CmsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: RedisCacheService,
    private readonly storage: StorageService,
    private readonly pricing: ProductPricingService,
  ) {}

  // -------------------------------------------------------------------------
  // Public home payload
  // -------------------------------------------------------------------------

  /**
   * Everything the storefront home page needs, in one cached response.
   *
   * The cache is the whole point: the page is hit on every visit and changes
   * only when an admin edits CMS content, which every write path here
   * invalidates. Two minutes is a safety net for a missed invalidation, not the
   * freshness model.
   */
  async getHome(): Promise<HomePayload> {
    const cached = await this.cache.get<HomePayload>(HOME_CACHE_KEY);

    if (cached) {
      return cached;
    }

    const now = new Date();

    // A null bound is "unbounded", so the window is expressed as two OR
    // clauses rather than a `NOT (start > now OR end < now)` expression that
    // Postgres will not use an index for.
    const liveWindow = {
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
      ],
    } satisfies Prisma.BannerWhereInput;

    const [banners, sections] = await Promise.all([
      this.prisma.banner.findMany({
        where: { isActive: true, ...liveWindow },
        orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.homeSection.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
    ]);

    const payload: HomePayload = {
      banners: banners.map((b) => this.toBannerView(b)),
      sections: await Promise.all(sections.map((s) => this.resolveSection(s))),
    };

    await this.cache.set(HOME_CACHE_KEY, payload, HOME_CACHE_TTL);

    return payload;
  }

  // -------------------------------------------------------------------------
  // Banners
  // -------------------------------------------------------------------------

  async listBanners(query: ListBannersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;

    const where: Prisma.BannerWhereInput = query.placement
      ? { placement: query.placement }
      : {};

    // Admin view, so inactive and scheduled banners are included — an operator
    // needs to see what is queued before it goes live.
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.banner.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }],
      }),
      this.prisma.banner.count({ where }),
    ]);

    return {
      items: rows.map((b) => this.toBannerView(b)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getBanner(id: string) {
    const banner = await this.prisma.banner.findUnique({ where: { id } });

    if (!banner) {
      throw new NotFoundException('Banner not found');
    }

    return this.toBannerView(banner);
  }

  async createBanner(dto: CreateBannerDto) {
    const linkValue = this.validateLink(dto.linkType ?? BannerLinkType.NONE, dto.linkValue);

    if (
      dto.startsAt &&
      dto.endsAt &&
      new Date(dto.startsAt).getTime() > new Date(dto.endsAt).getTime()
    ) {
      throw new BadRequestException('startsAt must be before endsAt');
    }

    const banner = await this.prisma.banner.create({
      data: {
        title: dto.title,
        imageUrl: dto.imageUrl,
        mobileImageUrl: dto.mobileImageUrl,
        linkType: dto.linkType ?? BannerLinkType.NONE,
        linkValue,
        placement: dto.placement,
        sortOrder: dto.sortOrder ?? 0,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
        isActive: dto.isActive ?? true,
      },
    });

    await this.invalidateHome();

    return this.toBannerView(banner);
  }

  async updateBanner(id: string, dto: UpdateBannerDto) {
    const existing = await this.prisma.banner.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('Banner not found');
    }

    // Merging against the stored row keeps a partial update valid: switching
    // linkType to URL with no linkValue must be caught against the URL already
    // on the banner, not silently accepted because this payload omitted it.
    const nextLinkType = dto.linkType ?? existing.linkType;
    const nextLinkValue =
      dto.linkValue !== undefined ? dto.linkValue : existing.linkValue;
    const linkValue = this.validateLink(nextLinkType, nextLinkValue);

    const startsAt =
      dto.startsAt !== undefined
        ? dto.startsAt
          ? new Date(dto.startsAt)
          : null
        : existing.startsAt;
    const endsAt =
      dto.endsAt !== undefined
        ? dto.endsAt
          ? new Date(dto.endsAt)
          : null
        : existing.endsAt;

    if (startsAt && endsAt && startsAt.getTime() > endsAt.getTime()) {
      throw new BadRequestException('startsAt must be before endsAt');
    }

    const banner = await this.prisma.banner.update({
      where: { id },
      data: {
        title: dto.title,
        imageUrl: dto.imageUrl,
        mobileImageUrl: dto.mobileImageUrl,
        linkType: dto.linkType,
        linkValue: dto.linkValue !== undefined || dto.linkType !== undefined ? linkValue : undefined,
        placement: dto.placement,
        sortOrder: dto.sortOrder,
        startsAt: dto.startsAt !== undefined ? startsAt : undefined,
        endsAt: dto.endsAt !== undefined ? endsAt : undefined,
        isActive: dto.isActive,
      },
    });

    await this.invalidateHome();

    return this.toBannerView(banner);
  }

  async removeBanner(id: string) {
    const banner = await this.prisma.banner.findUnique({ where: { id } });

    if (!banner) {
      throw new NotFoundException('Banner not found');
    }

    await this.prisma.banner.delete({ where: { id } });

    await this.invalidateHome();

    return { deleted: true, id };
  }

  async reorderBanners(placement: BannerPlacement, items: string[]) {
    const existing = await this.prisma.banner.findMany({
      where: { placement },
      select: { id: true },
    });
    const known = new Set(existing.map((b) => b.id));

    const unknown = items.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new BadRequestException(
        'These banner ids are not in the target placement: ' + unknown.join(', '),
      );
    }

    await this.applyOrder(this.completeOrder(items, existing.map((b) => b.id)), (id, sortOrder) =>
      this.prisma.banner.update({ where: { id }, data: { sortOrder } }),
    );

    await this.invalidateHome();

    return { reordered: items.length };
  }

  // -------------------------------------------------------------------------
  // Home sections
  // -------------------------------------------------------------------------

  async listSections(query: { page?: number; limit?: number }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.homeSection.findMany({
        skip: (page - 1) * limit,
        take: limit,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.homeSection.count(),
    ]);

    return {
      items: rows.map((s) => ({
        id: s.id,
        title: s.title,
        type: s.type,
        config: s.config,
        sortOrder: s.sortOrder,
        isActive: s.isActive,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getSection(id: string) {
    const section = await this.prisma.homeSection.findUnique({ where: { id } });

    if (!section) {
      throw new NotFoundException('Home section not found');
    }

    return section;
  }

  async createSection(dto: CreateSectionDto) {
    const config = this.normalizeConfig(dto.type, dto.config);

    const section = await this.prisma.homeSection.create({
      data: {
        title: dto.title,
        type: dto.type,
        config: config as Prisma.InputJsonValue,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
      },
    });

    await this.invalidateHome();

    return section;
  }

  async updateSection(id: string, dto: UpdateSectionDto) {
    const existing = await this.prisma.homeSection.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('Home section not found');
    }

    const section = await this.prisma.homeSection.update({
      where: { id },
      data: {
        title: dto.title,
        type: dto.type,
        config: dto.config
          ? (this.normalizeConfig(
              dto.type ?? existing.type,
              dto.config,
            ) as Prisma.InputJsonValue)
          : undefined,
        sortOrder: dto.sortOrder,
        isActive: dto.isActive,
      },
    });

    await this.invalidateHome();

    return section;
  }

  async removeSection(id: string) {
    const section = await this.prisma.homeSection.findUnique({ where: { id } });

    if (!section) {
      throw new NotFoundException('Home section not found');
    }

    await this.prisma.homeSection.delete({ where: { id } });

    await this.invalidateHome();

    return { deleted: true, id };
  }

  async reorderSections(items: string[]) {
    const existing = await this.prisma.homeSection.findMany({ select: { id: true } });
    const known = new Set(existing.map((s) => s.id));

    const unknown = items.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new BadRequestException(
        'Unknown home section ids: ' + unknown.join(', '),
      );
    }

    await this.applyOrder(this.completeOrder(items, existing.map((s) => s.id)), (id, sortOrder) =>
      this.prisma.homeSection.update({ where: { id }, data: { sortOrder } }),
    );

    await this.invalidateHome();

    return { reordered: items.length };
  }

  // -------------------------------------------------------------------------
  // Media
  // -------------------------------------------------------------------------

  /**
   * Uploads a banner creative through the shared B5 resize pipeline, so a
   * 4 MB PNG produces the same three WebP sizes a product image does instead
   * of being stored raw and shipped to phones.
   *
   * The upload is issued against a caller-supplied draft banner id when one is
   * given, which keeps the storage row attributable to a record that exists.
   */
  async uploadBannerImage(
    file: Express.Multer.File,
    target: 'imageUrl' | 'mobileImageUrl',
    bannerId?: string,
    uploadedById?: string,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    const uploaded = await this.storage.uploadImageVariants(file, {
      ownerType: 'BANNER_IMAGE',
      ownerId: bannerId ?? 'unassigned',
      uploadedById,
    });

    return {
      target,
      url: uploaded.url,
      mediumUrl: uploaded.mediumUrl,
      thumbUrl: uploaded.thumbUrl,
      width: uploaded.width,
      height: uploaded.height,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Turns a link into the value that is actually stored.
   *
   * `NONE` clears it instead of keeping a dangling id, so deactivating a link
   * never leaves a target the storefront would still try to navigate to.
   */
  private validateLink(
    linkType: BannerLinkType,
    linkValue?: string | null,
  ): string | null {
    if (linkType === BannerLinkType.NONE) {
      return null;
    }

    if (!linkValue) {
      throw new BadRequestException(`linkValue is required for linkType ${linkType}`);
    }

    if (linkType === BannerLinkType.URL) {
      let parsed: URL;
      try {
        parsed = new URL(linkValue);
      } catch {
        throw new BadRequestException('linkValue must be a valid absolute URL');
      }

      // Only http(s): a `javascript:` link here would be stored content handed
      // straight to the storefront to put in an href.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new BadRequestException('linkValue URL must use http or https');
      }

      return linkValue;
    }

    if (!/^[0-9a-fA-F-]{36}$/.test(linkValue)) {
      throw new BadRequestException(`linkValue must be a ${linkType.toLowerCase()} id`);
    }

    return linkValue;
  }

  /**
   * Validates a section config against its type and drops anything the type
   * does not read.
   *
   * Unknown ids are *not* rejected here: an operator who schedules a section
   * before creating the referenced products should not be blocked, so a missing
   * target resolves to fewer cards at read time.
   */
  private normalizeConfig(
    type: HomeSectionType,
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    const key = configKeyFor(type);

    const raw = config?.[key];
    if (!Array.isArray(raw)) {
      throw new BadRequestException(`config.${key} must be an array of ids`);
    }

    const ids = raw.filter(
      (v): v is string => typeof v === 'string' && /^[0-9a-fA-F-]{36}$/.test(v),
    );

    if (raw.length !== ids.length) {
      throw new BadRequestException(
        `config.${key} must contain only id strings`,
      );
    }

    if (ids.length > MAX_SECTION_ITEMS) {
      throw new BadRequestException(
        `config.${key} accepts at most ${MAX_SECTION_ITEMS} ids`,
      );
    }

    const normalized: Record<string, unknown> = { [key]: ids };

    // A flash-sale window is optional; when present it must parse, because the
    // storefront renders a countdown from it.
    if (type === HomeSectionType.FLASH_SALE && config?.['endsAt'] !== undefined) {
      const endsAt = config['endsAt'];

      if (typeof endsAt !== 'string' || Number.isNaN(Date.parse(endsAt))) {
        throw new BadRequestException('config.endsAt must be an ISO-8601 string');
      }

      normalized['endsAt'] = new Date(endsAt).toISOString();
    }

    return normalized;
  }

  /** Resolves one section's references into renderable cards. */
  private async resolveSection(section: {
    id: string;
    title: string;
    type: HomeSectionType;
    config: Prisma.JsonValue;
    sortOrder: number;
  }): Promise<HomeSectionView> {
    const config = (section.config ?? {}) as Record<string, unknown>;
    const base = {
      id: section.id,
      title: section.title,
      type: section.type,
      sortOrder: section.sortOrder,
    };

    switch (section.type) {
      case HomeSectionType.PRODUCT_LIST:
      case HomeSectionType.FLASH_SALE: {
        const ids = readIds(config, configKeyFor(section.type));

        return {
          ...base,
          endsAt:
            section.type === HomeSectionType.FLASH_SALE
              ? (config['endsAt'] as string | undefined) ?? null
              : null,
          // Section order is the display order, so the ids come back in the
          // order the admin entered rather than by whatever the database
          // returns.
          products: await this.resolveProductCards(ids),
        };
      }

      case HomeSectionType.CATEGORY_LIST: {
        const ids = readIds(config, 'categoryIds');

        const categories = ids.length
          ? await this.prisma.category.findMany({
              where: { id: { in: ids }, isActive: true, deletedAt: null },
              select: { id: true, name: true, slug: true, imageUrl: true },
            })
          : [];
        const byId = new Map(categories.map((c) => [c.id, c]));

        return {
          ...base,
          categories: ids
            .map((id) => byId.get(id))
            .filter((c): c is NonNullable<typeof c> => Boolean(c)),
        };
      }

      case HomeSectionType.BANNER: {
        const ids = readIds(config, 'bannerIds');
        const now = new Date();

        const banners = ids.length
          ? await this.prisma.banner.findMany({
              where: {
                id: { in: ids },
                isActive: true,
                OR: [{ startsAt: null }, { startsAt: { lte: now } }],
                AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
              },
            })
          : [];
        const byId = new Map(banners.map((b) => [b.id, b]));

        return {
          ...base,
          banners: ids
            .map((id) => byId.get(id))
            .filter((b): b is NonNullable<typeof b> => Boolean(b))
            .map((b) => this.toBannerView(b)),
        };
      }
    }
  }

  /**
   * Loads product cards for a set of ids in one query and resolves each price at
   * one unit.
   *
   * Archived and deleted products drop out rather than rendering as broken
   * cards: an operator disabling a product should empty its slot on the home
   * page without them having to edit the section.
   */
  private async resolveProductCards(ids: string[]): Promise<ProductCardView[]> {
    if (ids.length === 0) {
      return [];
    }

    const products = await this.prisma.product.findMany({
      where: {
        id: { in: ids },
        deletedAt: null,
        status: ProductStatus.ACTIVE,
      },
      include: PRODUCT_CARD_INCLUDE,
    });

    const byId = new Map(products.map((p) => [p.id, p]));
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((p): p is ProductCardRow => Boolean(p));

    return Promise.all(ordered.map((p) => this.toProductCard(p)));
  }

  private async toProductCard(product: ProductCardRow): Promise<ProductCardView> {
    const totalStock = product.variants.reduce((sum, v) => sum + v.stock, 0);

    // Same fallback as the wishlist: a wholesale-only product cannot be priced
    // at one unit, and a home card is not a checkout.
    let price = product.price;

    try {
      price = await this.pricing.resolveUnitPrice(product.id, 1);
    } catch {
      // Keep the listed price.
    }

    return {
      id: product.id,
      name: product.name,
      slug: product.slug,
      price: price.toFixed(2),
      inStock: totalStock > 0,
      thumbUrl: product.images[0]?.thumbUrl ?? null,
      vendor: product.vendor,
    };
  }

  private toBannerView(banner: {
    id: string;
    title: string;
    imageUrl: string;
    mobileImageUrl: string | null;
    linkType: BannerLinkType;
    linkValue: string | null;
    placement: BannerPlacement;
    sortOrder: number;
    startsAt: Date | null;
    endsAt: Date | null;
    isActive: boolean;
  }): BannerView {
    return {
      id: banner.id,
      title: banner.title,
      imageUrl: banner.imageUrl,
      mobileImageUrl: banner.mobileImageUrl,
      linkType: banner.linkType,
      linkValue: banner.linkValue,
      placement: banner.placement,
      sortOrder: banner.sortOrder,
      startsAt: banner.startsAt,
      endsAt: banner.endsAt,
      isActive: banner.isActive,
    };
  }

  /**
   * Writes the submitted order, then parks everything the client omitted after
   * it so an incomplete reorder is still a total ordering.
   */
  private async applyOrder(
    ordered: string[],
    setSortOrder: (id: string, sortOrder: number) => Prisma.PrismaPromise<unknown>,
  ) {
    await this.prisma.$transaction(
      ordered.map((id, index) => setSortOrder(id, index)),
    );
  }

  /**
   * Extends a partial reorder into a total one by appending whatever the client
   * did not mention, so no row is left holding a stale index.
   */
  private completeOrder(items: string[], allIds: string[]): string[] {
    const seen = new Set(items);

    return [...items, ...allIds.filter((id) => !seen.has(id))];
  }

  /**
   * Drops the cached home payload.
   *
   * Failures are logged rather than thrown: a stale home page for one TTL is
   * recoverable, and failing an admin's save because Redis blinked is not.
   */
  private async invalidateHome() {
    try {
      await this.cache.del(HOME_CACHE_KEY);
    } catch (error) {
      this.logger.warn(
        `Failed to invalidate ${HOME_CACHE_KEY}: ${(error as Error).message}`,
      );
    }
  }
}

function configKeyFor(type: HomeSectionType): string {
  switch (type) {
    case HomeSectionType.CATEGORY_LIST:
      return 'categoryIds';
    case HomeSectionType.BANNER:
      return 'bannerIds';
    default:
      return 'productIds';
  }
}

function readIds(config: Record<string, unknown>, key: string): string[] {
  const value = config?.[key];

  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
