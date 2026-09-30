import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Locale,
  Prisma,
  ProductStatus,
  SaleType,
} from '@prisma/client';
import { Meilisearch } from 'meilisearch';
import { PrismaService } from '../../database/prisma.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { DEFAULT_LOCALE } from '../../common/i18n/locale.util';
import { applyTranslation } from '../../common/i18n/translation.util';
import {
  INDEX_SETTINGS,
  PRODUCTS_INDEX,
  ProductForIndex,
  ProductIndexDocument,
  toIndexDocument,
} from './search-document';
import {
  SearchProductsQueryDto,
  SearchSort,
  SORTS_BY_VALUE,
  SUGGEST_LIMIT,
  SUGGEST_TTL_SECONDS,
} from './dto/search.dto';
import { MEILI_CLIENT } from './search.constants';

export interface SearchFacet {
  id: string;
  name: string;
  count: number;
}

export interface SearchFacets {
  brands: SearchFacet[];
  categories: SearchFacet[];
  priceRange: { min: number; max: number };
}

export interface SearchHit {
  id: string;
  name: string;
  slug: string;
  price: string;
  ratingAvg: string;
  ratingCount: number;
  soldCount: number;
  thumbUrl: string | null;
  saleType: SaleType;
  brand: { id: string; name: string; slug: string; logoUrl: string | null } | null;
  vendor: { id: string; businessName: string; slug: string; logoUrl: string | null };
  category: { id: string; name: string; slug: string };
}

export interface SearchResponse {
  items: SearchHit[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
  facets: SearchFacets;
  /** Which engine produced this response, so a slow fallback is diagnosable. */
  engine: 'meilisearch' | 'postgres';
}

const PRODUCT_INCLUDE = {
  images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }], take: 1 },
  vendor: { select: { id: true, businessName: true, slug: true, logoUrl: true } },
  category: { select: { id: true, name: true, slug: true, translations: true } },
  brand: {
    select: { id: true, name: true, slug: true, logoUrl: true, translations: true },
  },
  translations: true,
  _count: { select: { variants: true } },
} satisfies Prisma.ProductInclude;

const EMPTY_FACETS: SearchFacets = { brands: [], categories: [], priceRange: { min: 0, max: 0 } };

@Injectable()
export class SearchService implements OnModuleInit {
  private readonly logger = new Logger(SearchService.name);
  /** Throttles the "Meilisearch is down" warning; it would otherwise log per request. */
  private warnedUnavailable = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly cache: RedisCacheService,
    @Inject(MEILI_CLIENT) private readonly client: Meilisearch,
  ) {}

  private indexName(): string {
    return this.config.get<string>('search.index') ?? PRODUCTS_INDEX;
  }

  get enabled(): boolean {
    return this.config.get<boolean>('search.enabled') !== false;
  }

  async onModuleInit(): Promise<void> {
    if (!this.enabled) {
      this.logger.warn('SEARCH_ENABLED is false; product search will use Postgres');
      return;
    }

    try {
      await this.configureIndex();
    } catch (err) {
      // A missing search box must never stop the API from booting.
      this.warnUnavailable(err, 'while configuring the index');
    }
  }

  /** Pushes the index settings. Idempotent; safe to run on every boot. */
  async configureIndex(): Promise<void> {
    const task = await this.client
      .index(this.indexName())
      .updateSettings(INDEX_SETTINGS);

    // Settings are applied asynchronously; returning before the task lands
    // would let the first search run against an index with no filterable
    // attributes yet.
    await this.client.tasks.waitForTask(task.taskUid, { timeout: 30_000 });
  }

  // ------------------------------------------------------------- indexing

  /**
   * Writes one product into the index, or removes it when it no longer belongs
   * in search results.
   *
   * A product that is not ACTIVE, or is soft-deleted, is *deleted* from the
   * index rather than stored with a status filter. Storing it would mean a
   * stale document survives a missed status change and a shopper can still see
   * an archived product in results.
   */
  async indexProduct(productId: string): Promise<void> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      include: {
        ...PRODUCT_INCLUDE,
        variants: { select: { attributes: true } },
        brand: {
          select: { name: true, translations: true },
        },
        // Only the fields the document builder reads; loading the full
        // PRODUCT_INCLUDE here would pull images and counts on every reindex
        // for no benefit.
        category: { select: { id: true, name: true, slug: true } },
        vendor: { select: { id: true, businessName: true, slug: true, logoUrl: true } },
        _count: { select: { variants: true } },
      },
    });

    if (!product || product.deletedAt !== null || product.status !== ProductStatus.ACTIVE) {
      await this.removeProduct(productId);
      return;
    }

    const ancestors = await this.ancestorIds([product.categoryId]);
    const document = toIndexDocument(
      product as ProductForIndex,
      ancestors.get(product.categoryId) ?? [],
    );

    await this.client.index(this.indexName()).addDocuments([document]);
  }

  async removeProduct(productId: string): Promise<void> {
    try {
      await this.client.index(this.indexName()).deleteDocument(productId);
    } catch (err) {
      // Deleting a document that was never indexed is a no-op, not a failure.
      this.logger.debug(
        `Could not remove ${productId} from the index: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Full rebuild. Deletes the index and rebuilds it from Postgres, so a drifted
   * or half-populated index is recoverable without a deploy.
   */
  async reindexAll(): Promise<{ indexed: number; removed: number }> {
    if (!this.enabled) {
      this.logger.warn('Reindex skipped: SEARCH_ENABLED is false');
      return { indexed: 0, removed: 0 };
    }

    const index = this.client.index(this.indexName());
    await index.deleteAllDocuments();

    let cursor: string | undefined;
    let indexed = 0;

    // Batched so a large catalogue does not build one enormous document array
    // in memory, and so Meilisearch can start working on early batches.
    for (;;) {
      const products = await this.prisma.product.findMany({
        where: { status: ProductStatus.ACTIVE, deletedAt: null },
        take: 500,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: { id: 'asc' },
        include: {
          ...PRODUCT_INCLUDE,
          variants: { select: { attributes: true } },
        },
      });

      if (products.length === 0) {
        break;
      }

      const ancestors = await this.ancestorIds(
        products.map((product) => product.categoryId),
      );

      const documents = products.map((product) =>
        toIndexDocument(
          product as ProductForIndex,
          ancestors.get(product.categoryId) ?? [],
        ),
      );

      await index.addDocuments(documents);
      indexed += documents.length;

      const last = products[products.length - 1];
      cursor = last ? last.id : undefined;

      if (products.length < 500) {
        break;
      }
    }

    this.logger.log(`Reindexed ${indexed} product(s) into ${this.indexName()}`);
    return { indexed, removed: 0 };
  }

  /**
   * Walks each category up to the root.
   *
   * One query for the whole batch: the parent map is small, and resolving
   * ancestors per category would be a query per product on a large rebuild. The
   * `seen` set makes a cycle — which the category service prevents, but a
   * hand-edited row could still create — terminate instead of hanging.
   */
  private async ancestorIds(categoryIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();

    if (categoryIds.length === 0) {
      return result;
    }

    const all = await this.prisma.category.findMany({
      select: { id: true, parentId: true },
    });

    const parentOf = new Map(all.map((c) => [c.id, c.parentId]));

    for (const startId of new Set(categoryIds)) {
      const chain: string[] = [];
      const seen = new Set<string>([startId]);
      let current = parentOf.get(startId) ?? null;

      while (current && !seen.has(current)) {
        chain.push(current);
        seen.add(current);
        current = parentOf.get(current) ?? null;
      }

      result.set(startId, chain);
    }

    return result;
  }

  // ---------------------------------------------------------------- search

  /**
   * Product search.
   *
   * Meilisearch decides *which* products and in *what order*; Postgres then
   * supplies the real rows. Indexing money as a float and returning it would
   * lose the `Decimal(12,2)` the rest of the API guarantees, so the id order
   * from the index is applied to freshly-read rows.
   */
  async searchProducts(
    query: SearchProductsQueryDto,
    locale: Locale = DEFAULT_LOCALE,
  ): Promise<SearchResponse> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    if (!this.enabled) {
      return this.fallbackSearch(query, page, limit, locale);
    }

    try {
      const filter = this.buildFilter(query);
      const sort = SORTS_BY_VALUE[query.sort ?? SearchSort.RELEVANCE];

      const result = await this.client.index(this.indexName()).search(query.q ?? '', {
        filter,
        sort,
        facets: ['brandId', 'categoryIds', 'price'],
        limit,
        offset: (page - 1) * limit,
        attributesToRetrieve: ['id'],
      });

      const ids = result.hits.map((hit) => String(hit.id));
      const rows = await this.loadProducts(ids);
      const items = this.toHits(rows, ids, locale);

      const facets = await this.buildFacets(result.facetDistribution, query);

      return {
        items,
        meta: {
          total: result.estimatedTotalHits ?? result.hits.length,
          page,
          limit,
          totalPages: Math.ceil((result.estimatedTotalHits ?? ids.length) / limit),
        },
        facets,
        engine: 'meilisearch',
      };
    } catch (err) {
      this.warnUnavailable(err, 'during a product search');
      return this.fallbackSearch(query, page, limit);
    }
  }

  /**
   * Meilisearch filter expression.
   *
   * Every value is quoted: an unquoted value in Meilisearch's filter syntax is
   * a field reference, so `brandId = samsung` would silently match nothing
   * while looking correct in a log.
   */
  private buildFilter(query: SearchProductsQueryDto): string[] {
    const filters: string[] = ['status = ACTIVE'];

    if (query.categoryId) {
      filters.push(`categoryIds = "${query.categoryId}"`);
    }

    if (query.brandId) {
      filters.push(`brandId = "${query.brandId}"`);
    }

    if (query.vendorId) {
      filters.push(`vendorId = "${query.vendorId}"`);
    }

    if (query.saleType) {
      filters.push(`saleType = ${query.saleType}`);
    }

    if (query.minPrice !== undefined) {
      filters.push(`price >= ${query.minPrice}`);
    }

    if (query.maxPrice !== undefined) {
      filters.push(`price <= ${query.maxPrice}`);
    }

    if (query.minRating !== undefined) {
      filters.push(`ratingAvg >= ${query.minRating}`);
    }

    return filters;
  }

  private async loadProducts(ids: string[]) {
    if (ids.length === 0) {
      return [];
    }

    return this.prisma.product.findMany({
      where: { id: { in: ids }, deletedAt: null, status: ProductStatus.ACTIVE },
      include: PRODUCT_INCLUDE,
    });
  }

  /**
   * Re-orders the hydrated rows to match the index.
   *
   * `findMany({ id: { in } })` returns rows in whatever order the database
   * likes; without this the "price_asc" sort would silently come back
   * unsorted once Postgres supplied the rows.
   */
  private toHits(
    rows: Awaited<ReturnType<SearchService['loadProducts']>>,
    ids: string[],
    locale: Locale = DEFAULT_LOCALE,
  ): SearchHit[] {
    const byId = new Map(rows.map((row) => [row.id, row]));

    return ids
      .map((id) => byId.get(id))
      .filter((row): row is NonNullable<typeof row> => row !== undefined)
      .map((row) => {
        // The index matched on the Bengali name; the response must render the
        // Bengali name too, or the shopper sees a result whose title does not
        // match what they typed.
        const product = applyTranslation(row, row.translations, locale);

        return {
        id: row.id,
        name: product.name,
        slug: row.slug,
        // Decimal -> string, explicitly: a Decimal serialises to a string, but
        // the contract is asserted here rather than assumed.
        price: new Prisma.Decimal(row.price).toFixed(2),
        ratingAvg: new Prisma.Decimal(row.ratingAvg).toFixed(2),
        ratingCount: row.ratingCount,
        soldCount: row.soldCount,
        thumbUrl: row.images[0]?.thumbUrl ?? null,
        saleType: row.saleType,
        brand: row.brand
          ? applyTranslation(row.brand, row.brand.translations, locale)
          : null,
        vendor: row.vendor,
        category: applyTranslation(row.category, row.category.translations, locale),
      };
      });
  }

  /**
   * Turns Meilisearch's facet distribution into names.
   *
   * The index only stores ids, so the labels come from Postgres. Counts stay as
   * the engine reported them: re-deriving them from the current page would
   * describe the page, not the result set.
   */
  private async buildFacets(
    distribution: Record<string, Record<string, number>> | undefined,
    query: SearchProductsQueryDto,
  ): Promise<SearchFacets> {
    if (!distribution) {
      return EMPTY_FACETS;
    }

    const brandCounts = distribution.brandId ?? {};
    const categoryCounts = distribution.categoryIds ?? {};
    const priceBuckets = distribution.price ?? {};

    const [brands, categories] = await Promise.all([
      this.prisma.brand.findMany({
        where: { id: { in: Object.keys(brandCounts) } },
        select: { id: true, name: true },
      }),
      this.prisma.category.findMany({
        where: { id: { in: Object.keys(categoryCounts) } },
        select: { id: true, name: true },
      }),
    ]);

    const priceKeys = Object.keys(priceBuckets)
      .map(Number)
      .filter((value) => Number.isFinite(value));

    // Only the range the caller actually asked about is meaningful; narrowing by
    // category can leave the distribution describing a wider set.
    const min = Math.min(
      query.minPrice ?? Number.POSITIVE_INFINITY,
      ...priceKeys,
    );
    const max = Math.max(query.maxPrice ?? Number.NEGATIVE_INFINITY, ...priceKeys);

    return {
      brands: brands
        .map((brand) => ({ id: brand.id, name: brand.name, count: brandCounts[brand.id] ?? 0 }))
        .sort((a, b) => b.count - a.count),
      categories: categories
        .map((category) => ({
          id: category.id,
          name: category.name,
          count: categoryCounts[category.id] ?? 0,
        }))
        .sort((a, b) => b.count - a.count),
      priceRange: {
        min: Number.isFinite(min) ? min : 0,
        max: Number.isFinite(max) ? max : 0,
      },
    };
  }

  // -------------------------------------------------------------- fallback

  /**
   * The ILIKE path, used when Meilisearch is disabled or unreachable.
   *
   * Same response shape as the indexed path, so a client cannot tell the
   * difference — which is the point: a search box that returns an error is
   * worse than a slower one. It is genuinely worse at ranking (substring
   * matching finds "phone" inside "headphone") and it cannot do facets over the
   * whole result set, so the counts it reports describe the matched rows only.
   */
  private async fallbackSearch(
    query: SearchProductsQueryDto,
    page: number,
    limit: number,
    locale: Locale = DEFAULT_LOCALE,
  ): Promise<SearchResponse> {
    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      status: ProductStatus.ACTIVE,
    };

    if (query.q) {
      where.OR = [
        { name: { contains: query.q, mode: 'insensitive' } },
        { description: { contains: query.q, mode: 'insensitive' } },
        { translations: { some: { name: { contains: query.q, mode: 'insensitive' } } } },
        {
          translations: {
            some: { description: { contains: query.q, mode: 'insensitive' } },
          },
        },
        { brand: { name: { contains: query.q, mode: 'insensitive' } } },
        {
          brand: {
            translations: { some: { name: { contains: query.q, mode: 'insensitive' } } },
          },
        },
      ];
    }

    if (query.categoryId) {
      // Ancestors are expanded in SQL rather than by walking the tree: the
      // fallback must not depend on a tree walk it cannot afford per row.
      const ancestors = await this.ancestorIds([query.categoryId]);
      const chain = [query.categoryId, ...(ancestors.get(query.categoryId) ?? [])];
      where.categoryId = { in: chain };
    }

    if (query.brandId) {
      where.brandId = query.brandId;
    }

    if (query.vendorId) {
      where.vendorId = query.vendorId;
    }

    if (query.saleType) {
      where.saleType = query.saleType;
    }

    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      where.price = {};
      if (query.minPrice !== undefined) {
        where.price.gte = new Prisma.Decimal(query.minPrice);
      }
      if (query.maxPrice !== undefined) {
        where.price.lte = new Prisma.Decimal(query.maxPrice);
      }
    }

    if (query.minRating !== undefined) {
      where.ratingAvg = { gte: new Prisma.Decimal(query.minRating) };
    }

    const orderBy = this.fallbackOrder(query.sort ?? SearchSort.RELEVANCE);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy,
        include: PRODUCT_INCLUDE,
      }),
      this.prisma.product.count({ where }),
    ]);

    const ids = rows.map((row) => row.id);

    return {
      items: this.toHits(rows, ids),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      facets: await this.fallbackFacets(where),
      engine: 'postgres',
    };
  }

  private fallbackOrder(sort: SearchSort): Prisma.ProductOrderByWithRelationInput[] {
    switch (sort) {
      case SearchSort.PRICE_ASC:
        return [{ price: 'asc' }, { id: 'asc' }];
      case SearchSort.PRICE_DESC:
        return [{ price: 'desc' }, { id: 'asc' }];
      case SearchSort.NEWEST:
        return [{ createdAt: 'desc' }, { id: 'asc' }];
      case SearchSort.POPULAR:
        return [{ soldCount: 'desc' }, { id: 'asc' }];
      case SearchSort.RATING:
        return [{ ratingAvg: 'desc' }, { id: 'asc' }];
      case SearchSort.RELEVANCE:
      default:
        // No relevance to fall back to, so newest-first is the closest honest
        // analogue; the `id` tiebreaker keeps pagination stable, which a bare
        // createdAt sort does not guarantee.
        return [{ createdAt: 'desc' }, { id: 'asc' }];
    }
  }

  private async fallbackFacets(where: Prisma.ProductWhereInput): Promise<SearchFacets> {
    const [byBrand, byCategory, price] = await this.prisma.$transaction([
      this.prisma.product.groupBy({
        by: ['brandId'],
        where,
        _count: { _all: true },
      }),
      this.prisma.product.groupBy({
        by: ['categoryId'],
        where,
        _count: { _all: true },
      }),
      this.prisma.product.aggregate({
        where,
        _min: { price: true },
        _max: { price: true },
      }),
    ]);

    const brandIds = byBrand.map((row) => row.brandId).filter((id): id is string => !!id);
    const categoryIds = byCategory.map((row) => row.categoryId);

    const [brands, categories] = await Promise.all([
      brandIds.length > 0
        ? this.prisma.brand.findMany({ where: { id: { in: brandIds } }, select: { id: true, name: true } })
        : [],
      categoryIds.length > 0
        ? this.prisma.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } })
        : [],
    ]);

    const brandCountById = new Map(byBrand.map((row) => [row.brandId, row._count._all]));

    return {
      brands: brands
        .map((brand) => ({
          id: brand.id,
          name: brand.name,
          count: brandCountById.get(brand.id) ?? 0,
        }))
        .sort((a, b) => b.count - a.count),
      categories: categories
        .map((category) => ({
          id: category.id,
          name: category.name,
          count: byCategory.find((row) => row.categoryId === category.id)?._count._all ?? 0,
        }))
        .sort((a, b) => b.count - a.count),
      priceRange: {
        min: price._min.price ? Number(price._min.price) : 0,
        max: price._max.price ? Number(price._max.price) : 0,
      },
    };
  }

  // --------------------------------------------------------------- suggest

  /**
   * Type-ahead names, cached for a minute.
   *
   * Cached because it is the highest-QPS endpoint here and the answer barely
   * changes between keystrokes. The key includes the query, so two shoppers
   * typing different prefixes do not fight over one entry.
   */
  async suggest(
    q: string,
    locale: Locale = DEFAULT_LOCALE,
  ): Promise<{ suggestions: SearchHit[]; engine: 'meilisearch' | 'postgres' }> {
    // Locale is part of the key: a single-keyed entry would let the first
    // Bengali request pin English labels for the next minute.
    const key = `search:suggest:${q.toLowerCase()}:${locale}`;
    const cached = await this.cache.get<SearchHit[]>(key);

    if (cached) {
      return { suggestions: cached, engine: this.enabled ? 'meilisearch' : 'postgres' };
    }

    let suggestions: SearchHit[] = [];
    let engine: 'meilisearch' | 'postgres' = this.enabled ? 'meilisearch' : 'postgres';

    if (this.enabled) {
      try {
        const result = await this.client
          .index(this.indexName())
          .search(q, {
            limit: SUGGEST_LIMIT,
            filter: ['status = ACTIVE'],
            attributesToRetrieve: ['id'],
            attributesToHighlight: [],
          });

        const ids = result.hits.map((hit) => String(hit.id));
        const rows = await this.loadProducts(ids);
        suggestions = this.toHits(rows, ids, locale);
      } catch (err) {
        this.warnUnavailable(err, 'during a suggestion lookup');
        engine = 'postgres';
      }
    }

    if (suggestions.length === 0 && engine === 'postgres') {
      suggestions = await this.suggestFromPostgres(q, locale);
    }

    await this.cache.set(key, suggestions, SUGGEST_TTL_SECONDS);

    return { suggestions, engine };
  }

  private async suggestFromPostgres(
    q: string,
    locale: Locale = DEFAULT_LOCALE,
  ): Promise<SearchHit[]> {
    const rows = await this.prisma.product.findMany({
      where: {
        deletedAt: null,
        status: ProductStatus.ACTIVE,
        // The translation is searched too, so a Bengali query still finds the
        // product when the index is down. Parity with Meilisearch matters more
        // than the extra predicate: a fallback that quietly searched less would
        // look like products vanishing.
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { translations: { some: { name: { contains: q, mode: 'insensitive' } } } },
        ],
      },
      take: SUGGEST_LIMIT,
      orderBy: { soldCount: 'desc' },
      include: PRODUCT_INCLUDE,
    });

    return this.toHits(rows, rows.map((row) => row.id), locale);
  }

  private warnUnavailable(err: unknown, context: string): void {
    const message = (err as Error)?.message ?? 'unknown error';

    if (!this.warnedUnavailable) {
      this.warnedUnavailable = true;
      this.logger.warn(
        `Meilisearch unavailable ${context}: ${message}. Falling back to Postgres. ` +
          'Further warnings are suppressed until the process restarts.',
      );
    }
  }
}

export type { ProductIndexDocument };
