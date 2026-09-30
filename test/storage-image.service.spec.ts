import { describe, expect, it, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import { StorageDriver } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import {
  StorageService,
  UploadedImageVariants,
} from '../src/modules/storage/storage.service';
import { StorageProvider } from '../src/modules/storage/interfaces/storage-provider.interface';
import { StorageUrlService } from '../src/modules/storage/storage-url.service';
import { ImageProcessorService } from '../src/modules/storage/image-processor.service';
import { PrismaService } from '../src/database/prisma.service';
import { STORAGE_DRIVER_NAME, STORAGE_PROVIDER } from '../src/modules/storage/storage.constants';

const jpeg = (width: number, height: number): Promise<Buffer> =>
  sharp({
    create: { width, height, channels: 3, background: { r: 5, g: 90, b: 200 } },
  })
    .jpeg()
    .toBuffer();

const multerFile = (buffer: Buffer, mimetype = 'image/jpeg') =>
  ({
    buffer,
    mimetype,
    size: buffer.length,
    originalname: 'photo.jpg',
  }) as unknown as Express.Multer.File;

describe('StorageService image variants', () => {
  let prisma: { storageFile: { create: ReturnType<typeof vi.fn> } };
  let provider: StorageProvider;
  let urls: StorageUrlService;
  let images: ImageProcessorService;
  let service: StorageService;
  let cdn: string | null;

  const buildConfig = () =>
    ({
      get: (key: string) => {
        const map: Record<string, unknown> = {
          'storage.image.maxBytes': 5 * 1024 * 1024,
          'storage.image.maxDimension': 6000,
          'storage.image.quality': 80,
          'storage.cdnBaseUrl': cdn,
        };
        return map[key];
      },
    }) as unknown as ConfigService;

  beforeEach(() => {
    cdn = null;

    prisma = {
      storageFile: { create: vi.fn().mockResolvedValue({ id: 'sf-1' }) },
    };

    provider = {
      upload: vi.fn(async (_f, path) => ({ url: `/uploads/${path}`, key: path })),
      delete: vi.fn(),
      getSignedUrl: vi.fn(),
    } as unknown as StorageProvider;

    const config = buildConfig();
    urls = new StorageUrlService(config);
    images = new ImageProcessorService(config);

    service = new StorageService(
      prisma as unknown as PrismaService,
      provider,
      StorageDriver.LOCAL,
      urls,
      images,
    );
  });

  it('returns all three variant URLs from one upload call', async () => {
    const result: UploadedImageVariants = await service.uploadImageVariants(
      multerFile(await jpeg(1000, 800)),
      { ownerType: 'PRODUCT_IMAGE', ownerId: 'product-1' },
    );

    expect(result.thumbUrl).toMatch(/\.webp$/);
    expect(result.mediumUrl).toMatch(/\.webp$/);
    expect(result.url).toMatch(/\.webp$/);

    expect(result.thumbUrl).toContain('-thumb-');
    expect(result.mediumUrl).toContain('-medium-');
    expect(result.url).toContain('-large-');
  });

  it('registers a StorageFile row per variant', async () => {
    await service.uploadImageVariants(multerFile(await jpeg(1000, 800)), {
      ownerType: 'PRODUCT_IMAGE',
      ownerId: 'product-1',
    });

    expect(prisma.storageFile.create).toHaveBeenCalledTimes(3);

    for (const call of prisma.storageFile.create.mock.calls) {
      const arg = call[0] as { data: Record<string, unknown> };
      expect(arg.data.mimeType).toBe('image/webp');
      expect(arg.data.ownerType).toBe('PRODUCT_IMAGE');
      expect(arg.data.ownerId).toBe('product-1');
    }
  });

  it('reports the source dimensions', async () => {
    const result = await service.uploadImageVariants(
      multerFile(await jpeg(1000, 800)),
      { ownerType: 'PRODUCT_IMAGE', ownerId: 'product-1' },
    );

    expect(result.width).toBe(1000);
    expect(result.height).toBe(800);
  });

  it('produces keys containing a content hash', async () => {
    await service.uploadImageVariants(multerFile(await jpeg(1000, 800)), {
      ownerType: 'PRODUCT_IMAGE',
      ownerId: 'product-1',
    });

    const keys = (provider.upload as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call as unknown as [unknown, string])[1],
    );

    for (const key of keys) {
      expect(key).toMatch(/-[a-f0-9]{16}\.webp$/);
    }
  });

  it('applies CDN_BASE_URL to every returned URL', async () => {
    cdn = 'https://cdn.example.com';

    const result = await service.uploadImageVariants(
      multerFile(await jpeg(1000, 800)),
      { ownerType: 'PRODUCT_IMAGE', ownerId: 'product-1' },
    );

    for (const url of [result.url, result.mediumUrl, result.thumbUrl]) {
      expect(url.startsWith('https://cdn.example.com/')).toBe(true);
    }

    // The stored URL is the CDN one too, so reads and writes agree.
    const storedUrls = prisma.storageFile.create.mock.calls.map(
      (call) => (call[0] as { data: { url: string } }).data.url,
    );
    expect(
      storedUrls.every((u) => u.startsWith('https://cdn.example.com/')),
    ).toBe(true);
  });

  it('keeps local /uploads paths when no CDN is set', async () => {
    const result = await service.uploadImageVariants(
      multerFile(await jpeg(1000, 800)),
      { ownerType: 'PRODUCT_IMAGE', ownerId: 'product-1' },
    );

    expect(result.thumbUrl.startsWith('/uploads/')).toBe(true);
  });

  it('rejects an image over 5MB before uploading anything', async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 7);

    await expect(
      service.uploadImageVariants(multerFile(oversized), {
        ownerType: 'PRODUCT_IMAGE',
        ownerId: 'product-1',
      }),
    ).rejects.toThrow(/too large/i);

    expect(provider.upload).not.toHaveBeenCalled();
    expect(prisma.storageFile.create).not.toHaveBeenCalled();
  });

  it('rejects an image wider than 6000px before uploading anything', async () => {
    const wide = await jpeg(6001, 100);

    await expect(
      service.uploadImageVariants(multerFile(wide), {
        ownerType: 'PRODUCT_IMAGE',
        ownerId: 'product-1',
      }),
    ).rejects.toThrow(/dimensions too large/i);

    expect(provider.upload).not.toHaveBeenCalled();
  });

  it('rejects a non-image upload', async () => {
    await expect(
      service.uploadImageVariants(multerFile(Buffer.from('%PDF-1.4'), 'application/pdf'), {
        ownerType: 'PRODUCT_IMAGE',
        ownerId: 'product-1',
      }),
    ).rejects.toThrow(/too large|Unsupported|could not read/i);
  });

  it('rejects a missing file', async () => {
    await expect(
      service.uploadImageVariants(
        undefined as unknown as Express.Multer.File,
        { ownerType: 'PRODUCT_IMAGE', ownerId: 'product-1' },
      ),
    ).rejects.toThrow(/No file provided/);
  });

});
