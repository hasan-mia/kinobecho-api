/**
 * Full rebuild of the Meilisearch product index.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/reindex-search.ts
 *   npm run search:reindex
 *
 * The index is a cache of Postgres, so this is the recovery tool: run it after
 * Meilisearch loses its data, after a schema change that alters a document, or
 * whenever a burst of failed enqueues left the index behind the catalogue.
 *
 * Deletes and re-adds every ACTIVE, non-deleted product. It does not attempt an
 * incremental diff — a full rebuild is fast enough at catalogue scale that
 * reasoning about what changed is the more likely source of bugs.
 */
import 'dotenv/config';
import { Meilisearch } from 'meilisearch';
import {
  Prisma,
  PrismaClient,
  ProductStatus,
} from '@prisma/client';

const INDEX = process.env.MEILI_INDEX ?? 'products';
const HOST = process.env.MEILI_HOST ?? 'http://localhost:7700';
const API_KEY = process.env.MEILI_MASTER_KEY;
const BATCH = Number(process.env.SEARCH_REINDEX_BATCH ?? 500);

const prisma = new PrismaClient();
const client = new Meilisearch({ host: HOST, apiKey: API_KEY, timeout: 10_000 });

const SETTINGS = {
  searchableAttributes: ['name', 'description', 'brandName', 'attributes', 'slug'],
  filterableAttributes: [
    'categoryIds',
    'brandId',
    'vendorId',
    'saleType',
    'status',
    'price',
    'ratingAvg',
    'soldCount',
    'attributes',
  ],
  sortableAttributes: ['price', 'createdAt', 'soldCount', 'ratingAvg'],
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
  rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
  typoTolerance: {
    enabled: true,
    minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 },
    disableOnAttributes: ['id', 'categoryIds', 'brandId', 'vendorId'],
  },
  pagination: { maxTotalHits: 10000 },
};

type Variant = { attributes: Prisma.JsonValue };
type Image = { thumbUrl: string | null; isPrimary: boolean; sortOrder: number };

function flattenAttributes(attributes: Prisma.JsonValue): string[] {
  const out: string[] = [];

  const walk = (value: Prisma.JsonValue | undefined): void => {
    if (value === null || value === undefined) {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }

    if (typeof value === 'object') {
      Object.values(value).forEach(walk);
      return;
    }

    const text = String(value).trim();
    if (text) {
      out.push(text);
    }
  };

  walk(attributes);
  return [...new Set(out)];
}

/** Walks each category to the root; the parent map is one small query. */
async function ancestorsFor(categoryIds: string[]): Promise<Map<string, string[]>> {
  const all = await prisma.category.findMany({ select: { id: true, parentId: true } });
  const parentOf = new Map(all.map((c) => [c.id, c.parentId]));
  const result = new Map<string, string[]>();

  for (const start of new Set(categoryIds)) {
    const chain: string[] = [];
    const seen = new Set<string>([start]);
    let current = parentOf.get(start) ?? null;

    while (current && !seen.has(current)) {
      chain.push(current);
      seen.add(current);
      current = parentOf.get(current) ?? null;
    }

    result.set(start, chain);
  }

  return result;
}

async function main(): Promise<void> {
  const index = client.index(INDEX);

  process.stdout.write(`Rebuilding "${INDEX}" at ${HOST} ...\n`);

  const settingsTask = await index.updateSettings(SETTINGS);
  await client.tasks.waitForTask(settingsTask.taskUid, { timeout: 60_000 });
  process.stdout.write('  settings applied\n');

  const deleteTask = await index.deleteAllDocuments();
  await client.tasks.waitForTask(deleteTask.taskUid, { timeout: 60_000 });
  process.stdout.write('  existing documents cleared\n');

  let cursor: string | undefined;
  let indexed = 0;

  for (;;) {
    const products = await prisma.product.findMany({
      where: { status: ProductStatus.ACTIVE, deletedAt: null },
      take: BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      include: {
        variants: { select: { attributes: true } },
        images: {
          orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
          take: 1,
          select: { thumbUrl: true, isPrimary: true, sortOrder: true },
        },
        brand: { select: { name: true } },
      },
    });

    if (products.length === 0) {
      break;
    }

    const ancestors = await ancestorsFor(products.map((p) => p.categoryId));

    const documents = products.map((product) => {
      const images: Image[] = product.images;
      const variants: Variant[] = product.variants;

      return {
        id: product.id,
        name: product.name,
        description: product.description ?? '',
        slug: product.slug,
        categoryIds: [
          product.categoryId,
          ...(ancestors.get(product.categoryId) ?? []),
        ].filter((id, index, all) => all.indexOf(id) === index),
        vendorId: product.vendorId,
        brandId: product.brandId,
        brandName: product.brand?.name ?? null,
        saleType: product.saleType,
        price: Number(new Prisma.Decimal(product.price).toFixed(2)),
        ratingAvg: Number(new Prisma.Decimal(product.ratingAvg).toFixed(2)),
        soldCount: product.soldCount,
        status: product.status,
        attributes: variants.flatMap((v) => flattenAttributes(v.attributes)),
        thumbUrl: images[0]?.thumbUrl ?? null,
        createdAt: product.createdAt.getTime(),
      };
    });

    const task = await index.addDocuments(documents);
    await client.tasks.waitForTask(task.taskUid, { timeout: 60_000 });

    indexed += documents.length;
    process.stdout.write(`  indexed ${indexed} product(s)\n`);

    const last = products[products.length - 1];
    cursor = last ? last.id : undefined;

    if (products.length < BATCH) {
      break;
    }
  }

  process.stdout.write(`Done. ${indexed} product(s) in "${INDEX}".\n`);
}

main()
  .catch((err) => {
    process.stderr.write(`Reindex failed: ${(err as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
