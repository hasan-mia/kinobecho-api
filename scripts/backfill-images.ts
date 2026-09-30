/**
 * Backfills WebP variants for product images uploaded before the image pipeline
 * existed.
 *
 * Idempotent by construction: a row that already has a `thumbUrl` and
 * `mediumUrl` is skipped, and because storage keys embed a content hash,
 * re-running produces the same keys for the same bytes. Safe to run repeatedly,
 * and safe to interrupt — each image is committed independently.
 *
 * Usage:
 *   npx ts-node scripts/backfill-images.ts [--dry-run] [--limit 50] [--force]
 *
 *   --dry-run  report what would change, write nothing
 *   --limit    process at most N images (default: all)
 *   --force    regenerate even rows that already have variants
 */
import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { ImageProcessorService } from '../src/modules/storage/image-processor.service';
import { StorageUrlService } from '../src/modules/storage/storage-url.service';
import { LocalStorageProvider } from '../src/modules/storage/providers/local.provider';
import { S3StorageProvider } from '../src/modules/storage/providers/s3.provider';
import { GcsStorageProvider } from '../src/modules/storage/providers/gcs.provider';
import { StorageProvider } from '../src/modules/storage/interfaces/storage-provider.interface';
import { StorageDriver } from '@prisma/client';
import * as configuration from '../src/config/configuration';



interface Argv {
  dryRun: boolean;
  force: boolean;
  limit: number | undefined;
}

function parseArgs(argv: string[]): Argv {
  const has = (flag: string) => argv.includes(flag);
  const limitIndex = argv.indexOf('--limit');

  return {
    dryRun: has('--dry-run'),
    force: has('--force'),
    limit:
      limitIndex >= 0 && argv[limitIndex + 1]
        ? Number(argv[limitIndex + 1])
        : undefined,
  };
}

function loadDotEnv() {
  // Minimal .env reader: the script runs outside Nest, so ConfigService's own
  // loader is not in play.
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');

  const envPath = path.resolve(process.cwd(), '.env');

  if (!fs.existsSync(envPath)) {
    return;
  }

  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);

    if (!match) {
      continue;
    }

    const key = match[1];
    let value = (match[2] ?? '').trim();

    if (key === undefined) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function resolveStorageProvider(config: ConfigService): StorageProvider {
  const driver = (config.get<string>('storage.driver') ?? 'local').toLowerCase();

  if (driver === 's3') {
    return new S3StorageProvider(config);
  }
  if (driver === 'gcs') {
    return new GcsStorageProvider(config);
  }
  return new LocalStorageProvider(config);
}

function resolveDriverName(): StorageDriver {
  const driver = (process.env.STORAGE_DRIVER ?? 'local').toLowerCase();

  if (driver === 's3') {
    return StorageDriver.S3;
  }
  if (driver === 'gcs') {
    return StorageDriver.GCS;
  }
  return StorageDriver.LOCAL;
}

async function main() {
  loadDotEnv();

  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  // A ConfigService backed by the real configuration factories, so the script
  // reads the same limits and CDN setting the running app does.
  const configValues: Record<string, unknown> = {
    storage: configuration.storageConfig(),
    order: configuration.orderConfig(),
  };

  const config = {
    get: (key: string) => {
      const segments = key.split('.');
      const namespace = segments[0];

      if (namespace === undefined) {
        return undefined;
      }

      const value = configValues[namespace] as Record<string, unknown> | undefined;

      if (!value) {
        return undefined;
      }

      const rest = segments.slice(1);

      let current: unknown = value;

      for (const part of rest) {
        if (current === null || typeof current !== 'object') {
          return undefined;
        }
        current = (current as Record<string, unknown>)[part];
      }

      return current as never;
    },
  } as unknown as ConfigService;

  const processor = new ImageProcessorService(config);
  const urls = new StorageUrlService(config);
  const provider = resolveStorageProvider(config);
  const driver = resolveDriverName();

  const where = args.force
    ? {}
    : { OR: [{ thumbUrl: null }, { mediumUrl: null }] };

  const images = await prisma.productImage.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    ...(args.limit ? { take: args.limit } : {}),
    select: {
      id: true,
      productId: true,
      url: true,
      thumbUrl: true,
      mediumUrl: true,
    },
  });

  console.log(
    `Backfilling ${images.length} product image(s)${args.dryRun ? ' (dry run)' : ''}`,
  );

  let updated = 0;
  let failed = 0;

  for (const image of images) {
    try {
      // The original bytes are read back from storage by their stored URL, so
      // the row is the single source of truth for what to process.
      const source = await readOriginalBytes(image.url);

      if (!source) {
        console.warn(`  ! ${image.id}: could not read source for ${image.url}`);
        failed += 1;
        continue;
      }

      const processed = await processor.process(source);

      if (args.dryRun) {
        console.log(
          `  - ${image.id}: would set ${processed.variants.length} variants ` +
            `(${processed.sourceWidth}x${processed.sourceHeight})`,
        );
        updated += 1;
        continue;
      }

      const byLabel = new Map(processed.variants.map((v) => [v.label, v]));

      const upload = async (label: 'thumb' | 'medium' | 'large') => {
        const variant = byLabel.get(label)!;
        const key = processor.buildVariantKey('PRODUCT_IMAGE', image.productId, variant);

        const { url } = await provider.upload(
          {
            buffer: variant.buffer,
            mimetype: 'image/webp',
            size: variant.sizeBytes,
            originalname: `${label}.webp`,
          } as unknown as Express.Multer.File,
          key,
        );

        await prisma.storageFile.create({
          data: {
            driver,
            bucketKey: key,
            url: urls.buildUrl(key, url),
            mimeType: 'image/webp',
            sizeBytes: variant.sizeBytes,
            ownerType: 'PRODUCT_IMAGE',
            ownerId: image.productId,
          },
        });

        return urls.buildUrl(key, url);
      };

      const [large, medium, thumb] = await Promise.all([
        upload('large'),
        upload('medium'),
        upload('thumb'),
      ]);

      await prisma.productImage.update({
        where: { id: image.id },
        data: {
          url: large,
          thumbUrl: thumb,
          mediumUrl: medium,
          width: processed.sourceWidth,
          height: processed.sourceHeight,
        },
      });

      console.log(`  ✓ ${image.id} -> ${processed.sourceWidth}x${processed.sourceHeight}`);
      updated += 1;
    } catch (error) {
      console.error(`  ✗ ${image.id}: ${(error as Error).message}`);
      failed += 1;
    }
  }

  console.log(`\nDone. updated=${updated} failed=${failed}`);

  await prisma.$disconnect();
}

/**
 * Fetches the bytes behind a stored URL.
 *
 * Only the local driver is supported: pulling objects back out of S3 or GCS
 * would need credentials and a network round trip per image, and a silent
 * no-op would be worse than an explicit failure. Rows on a remote driver are
 * reported as unreadable so they can be handled deliberately.
 */
async function readOriginalBytes(
  url: string,
): Promise<Buffer | null> {
  const driver = (process.env.STORAGE_DRIVER ?? 'local').toLowerCase();

  if (driver !== 'local') {
    console.warn(
      `  ! STORAGE_DRIVER=${driver}: original bytes are not fetched from remote storage. ` +
        `Re-run with a local export, or generate variants at the origin.`,
    );
    return null;
  }

  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const baseDir = path.resolve(process.env.LOCAL_UPLOAD_PATH ?? 'uploads');
  const assetUrl = (process.env.LOCAL_ASSET_URL ?? '/uploads').replace(/\/$/, '');

  // `/uploads/foo/bar.png` -> `foo/bar.png`
  const relative = url.startsWith(assetUrl)
    ? url.slice(assetUrl.length).replace(/^\/+/, '')
    : url.replace(/^\/+/, '');

  const absolute = path.join(baseDir, relative);

  if (!absolute.startsWith(baseDir)) {
    return null;
  }

  try {
    return await fs.readFile(absolute);
  } catch {
    return null;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
