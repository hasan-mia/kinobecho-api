import { Locale, Prisma, ProductStatus } from '@prisma/client';

export const PRODUCTS_INDEX = 'products';

/**
 * Locales carried on the index document as sibling fields rather than one
 * nested object.
 *
 * Meilisearch can search a flattened array, but not a nested object's values, so
 * `translations: [{locale, name}]` would be invisible to the query. One
 * `name_<locale>` column per supported locale is what makes both languages
 * searchable with a single query — which is the point: a Bangladeshi shopper
 * typing the Bengali name must find the product even on a request that did not
 * ask for a locale.
 */
const INDEXED_LOCALES = [Locale.bn] as const;

type IndexedLocale = (typeof INDEXED_LOCALES)[number];

/**
 * One product as Meilisearch sees it.
 *
 * Deliberately flat and self-contained: an index document has no joins, so
 * every field a filter or a sort needs must be materialised on it. The document
 * is a *search* record only — money is hydrated from Postgres before a response
 * leaves the service, because a `number` in an index cannot round-trip a
 * `Decimal(12,2)` faithfully.
 */
export interface ProductIndexDocument {
  id: string;
  name: string;
  description: string;
  /** Bengali name, or '' when untranslated. Absent keys are unsearchable. */
  'name_bn'?: string;
  'description_bn'?: string;
  slug: string;
  /** The product's own category plus every ancestor, so a parent filter matches. */
  categoryIds: string[];
  vendorId: string;
  brandId: string | null;
  brandName: string | null;
  saleType: string;
  /** Number for filtering and sorting only. Never returned to a client as money. */
  price: number;
  ratingAvg: number;
  soldCount: number;
  status: ProductStatus;
  /** Flattened variant attribute values, e.g. ['red', 'xl']. */
  attributes: string[];
  thumbUrl: string | null;
  /** Epoch millis: Meilisearch sorts on numbers, not on dates. */
  createdAt: number;
}

/**
 * `name` and `description` stay searchable alongside the Bengali columns, so a
 * search never *requires* a locale: a shopper may know either name, and
 * restricting search to the requested locale would hide real matches.
 */
export const SEARCHABLE_ATTRIBUTES = [
  'name',
  'name_bn',
  'description',
  'description_bn',
  'brandName',
  'attributes',
  'slug',
];

export const FILTERABLE_ATTRIBUTES = [
  'categoryIds',
  'brandId',
  'vendorId',
  'saleType',
  'status',
  'price',
  'ratingAvg',
  'soldCount',
  'attributes',
];

export const SORTABLE_ATTRIBUTES = [
  'price',
  'createdAt',
  'soldCount',
  'ratingAvg',
];

/**
 * The index's own settings.
 *
 * `typoTolerance` is left enabled deliberately: shoppers mistype, and a search
 * that returns nothing for "iphnoe" is indistinguishable from a broken one. It
 * is disabled only for the primary key and filter-only attributes, where a
 * typo would match the wrong product rather than a near one.
 */
const SETTINGS = {
  searchableAttributes: SEARCHABLE_ATTRIBUTES,
  filterableAttributes: FILTERABLE_ATTRIBUTES,
  sortableAttributes: SORTABLE_ATTRIBUTES,
  // Only what a client is allowed to see. `vendorId` and the full category
  // chain are filterable but not displayed: facet distribution and filtering
  // read filterable attributes, not this list.
  displayedAttributes: [
    'id',
    'name',
    'slug',
    'brandId',
    'categoryIds',
    'price',
    'ratingAvg',
    'soldCount',
    'thumbUrl',
  ],
  rankingRules: [
    'words',
    'typo',
    'proximity',
    'attribute',
    'sort',
    'exactness',
  ],
  typoTolerance: {
    enabled: true,
    minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 },
    // A typo in an id or a category code matches a *different* product, which
    // is worse than returning nothing.
    disableOnAttributes: ['id', 'categoryIds', 'brandId', 'vendorId'],
  },
  pagination: { maxTotalHits: 10000 },
};
/** Satisfies the SDK's mutable-array `Settings` type without loosening ours. */
export const INDEX_SETTINGS = SETTINGS as typeof SETTINGS & {
  displayedAttributes: string[];
  searchableAttributes: string[];
  filterableAttributes: string[];
  sortableAttributes: string[];
  rankingRules: string[];
};

export interface ProductForIndex {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  saleType: string;
  status: ProductStatus;
  price: Prisma.Decimal;
  ratingAvg: Prisma.Decimal;
  soldCount: number;
  createdAt: Date;
  categoryId: string;
  vendorId: string;
  brandId: string | null;
  brand?: { name: string; translations?: { locale: Locale; name: string }[] } | null;
  variants?: { attributes: Prisma.JsonValue }[];
  translations?: {
    locale: Locale;
    name: string;
    description: string | null;
  }[];
  images?: { thumbUrl: string | null; isPrimary: boolean; sortOrder: number }[];
}

/**
 * Flattens one variant's `attributes` JSON into plain values.
 *
 * The stored shape is vendor-supplied and arbitrary — `{"size":"M"}`,
 * `{"specs":{"ram":"16gb"}}`, `["red"]`. Only the leaf values are indexed:
 * a shopper searches for "16gb", not for the word "specs". Keys are dropped
 * because filtering happens on structured fields, and a searchable "color" would
 * match every product of a brand that happens to sell a colour.
 */
export function flattenAttributes(attributes?: Prisma.JsonValue | null): string[] {
  const out: string[] = [];

  const walk = (value: Prisma.JsonValue | undefined): void => {
    if (value === null || value === undefined) {
      return;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        walk(entry);
      }
      return;
    }

    if (typeof value === 'object') {
      for (const nested of Object.values(value)) {
        walk(nested);
      }
      return;
    }

    const text = String(value).trim();
    if (text) {
      out.push(text);
    }
  };

  walk(attributes);

  // Duplicated across variants of the same product would only bloat the index;
  // the searchable content is identical either way.
  return [...new Set(out)];
}

/**
 * Builds the document that is written to the index.
 *
 * `ancestorIds` is passed separately rather than derived: resolving the category
 * tree is a query against a different table, and the caller already has it.
 */
export function toIndexDocument(
  product: ProductForIndex,
  ancestorIds: string[] = [],
): ProductIndexDocument {
  const images = product.images ?? [];
  const primary = images.find((image) => image.isPrimary) ?? images[0];
  const ordered = primary
    ? primary
    : [...images].sort((a, b) => a.sortOrder - b.sortOrder)[0];

  // Absent translations become empty strings rather than being left out: a
  // missing key and an empty one behave differently in Meilisearch's ranking,
  // and one untranslated product must not shift how every other product scores.
  const byLocale = new Map(
    (product.translations ?? []).map((t) => [t.locale, t]),
  );
  const bn = byLocale.get(Locale.bn as IndexedLocale);

  return {
    id: product.id,
    name: product.name,
    description: product.description ?? '',
    'name_bn': bn?.name ?? '',
    'description_bn': bn?.description ?? '',
    slug: product.slug,
    // The product's own category first so a leaf-category filter is exact, with
    // ancestors after it for the parent roll-up.
    categoryIds: [product.categoryId, ...ancestorIds].filter(
      (id, index, all) => all.indexOf(id) === index,
    ),
    vendorId: product.vendorId,
    brandId: product.brandId,
    brandName: product.brand?.name ?? null,
    saleType: product.saleType,
    price: Number(new Prisma.Decimal(product.price).toFixed(2)),
    ratingAvg: Number(new Prisma.Decimal(product.ratingAvg).toFixed(2)),
    soldCount: product.soldCount,
    status: product.status,
    attributes: (product.variants ?? []).flatMap((variant) =>
      flattenAttributes(variant.attributes),
    ),
    thumbUrl: ordered?.thumbUrl ?? null,
    createdAt: product.createdAt.getTime(),
  };
}
