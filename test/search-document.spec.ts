import { describe, expect, it } from 'vitest';
import { Prisma, ProductStatus, SaleType } from '@prisma/client';
import {
  INDEX_SETTINGS,
  flattenAttributes,
  toIndexDocument,
} from '../src/modules/search/search-document';

const dec = (v: string) => new Prisma.Decimal(v);

const product = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'Phone',
  slug: 'phone',
  description: 'A phone',
  saleType: SaleType.RETAIL,
  status: ProductStatus.ACTIVE,
  price: dec('100.00'),
  ratingAvg: dec('4.50'),
  soldCount: 7,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  categoryId: 'c-child',
  vendorId: 'v1',
  brandId: 'b1',
  brand: { name: 'Brand One' },
  variants: [{ attributes: { color: 'red', size: 'M' } as Prisma.JsonValue }],
  images: [
    { thumbUrl: 'http://cdn/a.webp', isPrimary: false, sortOrder: 1 },
    { thumbUrl: 'http://cdn/b.webp', isPrimary: true, sortOrder: 2 },
  ],
  ...overrides,
});

describe('flattenAttributes', () => {
  it('takes the leaf values, not the keys', () => {
    expect(flattenAttributes({ color: 'red' } as Prisma.JsonValue).sort()).toEqual([
      'red',
    ]);
  });

  it('descends into nested objects', () => {
    const value = { specs: { ram: '16gb', storage: '512gb' } } as Prisma.JsonValue;

    expect(flattenAttributes(value).sort()).toEqual(['16gb', '512gb']);
  });

  it('handles a bare array', () => {
    expect(flattenAttributes(['red', 'blue'] as Prisma.JsonValue).sort()).toEqual([
      'blue',
      'red',
    ]);
  });

  it('handles a scalar and null', () => {
    expect(flattenAttributes('red' as Prisma.JsonValue)).toEqual(['red']);
    expect(flattenAttributes(null)).toEqual([]);
    expect(flattenAttributes(undefined)).toEqual([]);
  });

  it('de-duplicates, since a value repeated across variants adds nothing', () => {
    const value = { a: 'red', b: 'red' } as Prisma.JsonValue;

    expect(flattenAttributes(value)).toEqual(['red']);
  });

  it('ignores empty strings and trims', () => {
    const value = { a: '  ', b: ' red ' } as Prisma.JsonValue;

    expect(flattenAttributes(value)).toEqual(['red']);
  });
});

describe('toIndexDocument', () => {
  it('maps every field the search surface needs', () => {
    const doc = toIndexDocument(product(), ['c-parent', 'c-root']);

    expect(doc).toEqual({
      id: 'p1',
      name: 'Phone',
      description: 'A phone',
      slug: 'phone',
      categoryIds: ['c-child', 'c-parent', 'c-root'],
      vendorId: 'v1',
      brandId: 'b1',
      brandName: 'Brand One',
      saleType: SaleType.RETAIL,
      price: 100,
      ratingAvg: 4.5,
      soldCount: 7,
      status: ProductStatus.ACTIVE,
      attributes: ['red', 'M'],
      thumbUrl: 'http://cdn/b.webp',
      createdAt: Date.UTC(2026, 0, 1),
    });
  });

  it('stores price as a number, because Meilisearch filters on numbers', () => {
    const doc = toIndexDocument(product({ price: dec('79.99') }));

    expect(typeof doc.price).toBe('number');
    expect(doc.price).toBe(79.99);
  });

  it('turns the date into epoch millis, because it cannot sort on a Date', () => {
    const doc = toIndexDocument(product());

    expect(typeof doc.createdAt).toBe('number');
  });

  it('puts the product own category first so a leaf filter is exact', () => {
    const doc = toIndexDocument(product(), ['c-parent']);

    expect(doc.categoryIds[0]).toBe('c-child');
  });

  it('de-duplicates ancestors that repeat the product own category', () => {
    const doc = toIndexDocument(product(), ['c-child', 'c-parent']);

    expect(doc.categoryIds).toEqual(['c-child', 'c-parent']);
  });

  it('prefers the primary image as the thumbnail', () => {
    const doc = toIndexDocument(product());

    expect(doc.thumbUrl).toBe('http://cdn/b.webp');
  });

  it('falls back to the first image when none is marked primary', () => {
    const doc = toIndexDocument(
      product({
        images: [{ thumbUrl: 'http://cdn/a.webp', isPrimary: false, sortOrder: 1 }],
      }),
    );

    expect(doc.thumbUrl).toBe('http://cdn/a.webp');
  });

  it('has a null thumbnail rather than undefined when there are no images', () => {
    const doc = toIndexDocument(product({ images: [] }));

    expect(doc.thumbUrl).toBeNull();
  });

  it('merges attributes across every variant', () => {
    const doc = toIndexDocument(
      product({
        variants: [
          { attributes: { color: 'red' } as Prisma.JsonValue },
          { attributes: { color: 'blue', size: 'L' } as Prisma.JsonValue },
        ],
      }),
    );

    expect(doc.attributes.sort()).toEqual(['L', 'blue', 'red']);
  });

  it('leaves brand fields null for a product with no brand', () => {
    const doc = toIndexDocument(product({ brandId: null, brand: null }));

    expect(doc.brandId).toBeNull();
    expect(doc.brandName).toBeNull();
  });

  it('defaults a missing description to an empty string, not null', () => {
    // A null description is not searchable text; an empty string is.
    const doc = toIndexDocument(product({ description: null }));

    expect(doc.description).toBe('');
  });

  it('survives a product with no variants or no ancestors', () => {
    const doc = toIndexDocument(product({ variants: [] }));

    expect(doc.attributes).toEqual([]);
    expect(doc.categoryIds).toEqual(['c-child']);
  });
});

describe('index settings', () => {
  it('makes every field the filter and sort surface touches filterable', () => {
    for (const attribute of [
      'categoryIds',
      'brandId',
      'vendorId',
      'saleType',
      'status',
      'price',
      'ratingAvg',
      'soldCount',
    ]) {
      expect(INDEX_SETTINGS.filterableAttributes).toContain(attribute);
    }
  });

  it('makes every field the sort surface touches sortable', () => {
    for (const attribute of ['price', 'createdAt', 'soldCount', 'ratingAvg']) {
      expect(INDEX_SETTINGS.sortableAttributes).toContain(attribute);
    }
  });

  it('searches the text a shopper would actually type', () => {
    expect(INDEX_SETTINGS.searchableAttributes).toEqual(
      expect.arrayContaining(['name', 'description', 'brandName', 'attributes']),
    );
  });

  it('enables typo tolerance, because an empty result reads as broken', () => {
    expect(INDEX_SETTINGS.typoTolerance.enabled).toBe(true);
  });

  it('disables typo tolerance on identity fields, where a typo matches a different product', () => {
    expect(INDEX_SETTINGS.typoTolerance.disableOnAttributes).toEqual(
      expect.arrayContaining(['id', 'categoryIds', 'brandId', 'vendorId']),
    );
  });

  it('does not let a custom ranking rule outrank relevance by default', () => {
    // `soldCount:desc` as a ranking rule would reorder every query; it is only
    // reachable through an explicit sort.
    expect(INDEX_SETTINGS.rankingRules).not.toContain('soldCount:desc');
    expect(INDEX_SETTINGS.rankingRules).toContain('words');
  });

  it('displays only the fields a client may see', () => {
    expect(INDEX_SETTINGS.displayedAttributes).not.toContain('vendorId');
  });
});
