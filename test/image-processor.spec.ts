import { describe, expect, it, beforeEach } from 'vitest';
import sharp from 'sharp';
import { ConfigService } from '@nestjs/config';
import { ImageProcessorService } from '../src/modules/storage/image-processor.service';
import { StorageUrlService } from '../src/modules/storage/storage-url.service';

const png = (width: number, height: number): Promise<Buffer> =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 30, b: 30 },
    },
  })
    .png()
    .toBuffer();

const buildConfig = (overrides: Record<string, unknown> = {}) =>
  ({
    get: (key: string) => {
      const map: Record<string, unknown> = {
        'storage.image.maxBytes': 5 * 1024 * 1024,
        'storage.image.maxDimension': 6000,
        'storage.image.quality': 80,
        'storage.cdnBaseUrl': null,
        'storage.localAssetUrl': '/uploads',
        ...overrides,
      };
      return map[key];
    },
  }) as unknown as ConfigService;

describe('ImageProcessorService', () => {
  let processor: ImageProcessorService;

  beforeEach(() => {
    processor = new ImageProcessorService(buildConfig());
  });

  describe('validate', () => {
    it('accepts an image within the limits', async () => {
      const buffer = await png(800, 600);

      await expect(processor.validate(buffer)).resolves.toEqual({
        width: 800,
        height: 600,
      });
    });

    it('rejects a file over 5MB', async () => {
      const buffer = Buffer.alloc(5 * 1024 * 1024 + 1, 1);

      await expect(processor.validate(buffer)).rejects.toThrow(/too large/i);
      await expect(processor.validate(buffer)).rejects.toThrow(/5MB/);
    });

    it('rejects an image wider than the maximum dimension', async () => {
      // Declared dimensions short-circuit before any decode work.
      await expect(processor.validate(Buffer.alloc(10), 7000, 100)).rejects.toThrow(
        /dimensions too large/i,
      );
    });

    it('rejects an image taller than the maximum dimension', async () => {
      await expect(processor.validate(Buffer.alloc(10), 100, 7000)).rejects.toThrow(
        /dimensions too large/i,
      );
    });

    it('rejects a real image whose actual dimensions exceed the cap', async () => {
      // No declared dimensions: the check must fall through to reading the header.
      const buffer = await png(6001, 10);

      await expect(processor.validate(buffer)).rejects.toThrow(
        /dimensions too large/i,
      );
    });

    it('honours a configured byte limit lower than 5MB', async () => {
      const small = new ImageProcessorService(
        buildConfig({ 'storage.image.maxBytes': 1000 }),
      );

      await expect(small.validate(Buffer.alloc(1001))).rejects.toThrow(
        /too large/i,
      );
    });
  });

  describe('process', () => {
    it('generates thumb, medium and large variants', async () => {
      const result = await processor.process(await png(1600, 900));

      expect(result.variants.map((v) => v.label)).toEqual([
        'thumb',
        'medium',
        'large',
      ]);
    });

    it('scales each variant to its target width and keeps aspect ratio', async () => {
      const result = await processor.process(await png(1600, 900));
      const byLabel = new Map(result.variants.map((v) => [v.label, v]));

      // 1600x900 -> 16:9 preserved at every size.
      expect(byLabel.get('large')).toMatchObject({ width: 1200, height: 675 });
      expect(byLabel.get('medium')).toMatchObject({ width: 600, height: 338 });
      expect(byLabel.get('thumb')).toMatchObject({ width: 200, height: 113 });
    });

    it('fits portraits to the target width and keeps them taller', async () => {
      // The variants are width-targeted, so a 900x1600 portrait becomes 200 wide
      // and stays tall — it is not cropped to a 200x200 square.
      const result = await processor.process(await png(900, 1600));
      const thumb = result.variants.find((v) => v.label === 'thumb')!;

      expect(thumb.width).toBe(200);
      expect(thumb.height).toBe(356);
      expect(thumb.height).toBeGreaterThan(thumb.width);
    });

    it('encodes every variant as webp', async () => {
      const result = await processor.process(await png(800, 600));

      for (const variant of result.variants) {
        const meta = await sharp(variant.buffer).metadata();
        expect(meta.format).toBe('webp');
      }
    });

    it('does not upscale a small image', async () => {
      // 150px wide is smaller than every target, so every variant stays 150px.
      const result = await processor.process(await png(150, 100));

      for (const variant of result.variants) {
        expect(variant.width).toBe(150);
        expect(variant.height).toBe(100);
      }
    });

    it('does not upscale one dimension past the source', async () => {
      // 2000x100: large is width-capped at 1200, never stretched to 1200 tall.
      const result = await processor.process(await png(2000, 100));
      const large = result.variants.find((v) => v.label === 'large')!;

      expect(large.width).toBe(1200);
      expect(large.height).toBe(60);
    });

    it('reports the source dimensions', async () => {
      const result = await processor.process(await png(1234, 567));

      expect(result.sourceWidth).toBe(1234);
      expect(result.sourceHeight).toBe(567);
    });

    it('strips EXIF metadata from every variant', async () => {
      // A PNG carrying an EXIF block with a GPS tag.
      const withExif = await sharp({
        create: {
          width: 800,
          height: 600,
          channels: 3,
          background: { r: 10, g: 20, b: 30 },
        },
      })
        .withExif({
          IFD0: { Copyright: 'should not survive' },
        })
        .png()
        .toBuffer();

      const result = await processor.process(withExif);

      for (const variant of result.variants) {
        const meta = await sharp(variant.buffer).metadata();
        // WebP output carries no EXIF here: a re-encode without withMetadata
        // drops it, which is what keeps a GPS-tagged photo from leaking place.
        expect(meta.exif).toBeUndefined();
      }
    });

    it('shrinks a large image relative to a PNG source', async () => {
      const source = await png(2000, 2000);
      const result = await processor.process(source);
      const large = result.variants.find((v) => v.label === 'large')!;

      // Lossy WebP at quality 80 on flat colour is dramatically smaller.
      expect(large.sizeBytes).toBeLessThan(source.length);
    });
  });

  describe('buildVariantKey', () => {
    it('embeds the label and the content hash', async () => {
      const result = await processor.process(await png(400, 300));
      const thumb = result.variants.find((v) => v.label === 'thumb')!;

      const key = processor.buildVariantKey(
        'PRODUCT_IMAGE',
        'product-1',
        thumb,
        new Date('2026-01-15T00:00:00Z'),
      );

      expect(key).toBe(
        `product_image/2026-01/product-1-thumb-${thumb.checksum}.webp`,
      );
    });

    it('produces an identical key for identical bytes', async () => {
      const buffer = await png(400, 300);
      const date = new Date('2026-01-15T00:00:00Z');

      const a = await processor.process(buffer);
      const b = await processor.process(buffer);

      const keyA = processor.buildVariantKey(
        'PRODUCT_IMAGE',
        'p1',
        a.variants.find((v) => v.label === 'thumb')!,
        date,
      );
      const keyB = processor.buildVariantKey(
        'PRODUCT_IMAGE',
        'p1',
        b.variants.find((v) => v.label === 'thumb')!,
        date,
      );

      // Content addressing is what makes an immutable Cache-Control safe.
      expect(keyA).toBe(keyB);
    });

    it('produces a different key for different content', async () => {
      const date = new Date('2026-01-15T00:00:00Z');

      const a = await processor.process(await png(400, 300));
      const b = await processor.process(
        await sharp({
          create: {
            width: 400,
            height: 300,
            channels: 3,
            background: { r: 1, g: 2, b: 3 },
          },
        })
          .png()
          .toBuffer(),
      );

      const keyA = processor.buildVariantKey(
        'PRODUCT_IMAGE',
        'p1',
        a.variants.find((v) => v.label === 'thumb')!,
        date,
      );
      const keyB = processor.buildVariantKey(
        'PRODUCT_IMAGE',
        'p1',
        b.variants.find((v) => v.label === 'thumb')!,
        date,
      );

      expect(keyA).not.toBe(keyB);
    });
  });
});

describe('StorageUrlService', () => {
  it('returns the provider URL when no CDN is configured', () => {
    const service = new StorageUrlService(buildConfig());

    expect(service.buildUrl('product_image/2026-01/a.webp', '/uploads/a.webp')).toBe(
      '/uploads/a.webp',
    );
  });

  it('builds CDN_BASE_URL + key when configured', () => {
    const service = new StorageUrlService(
      buildConfig({ 'storage.cdnBaseUrl': 'https://cdn.example.com' }),
    );

    expect(
      service.buildUrl('product_image/2026-01/a.webp', '/uploads/a.webp'),
    ).toBe('https://cdn.example.com/product_image/2026-01/a.webp');
  });

  it('does not double up slashes', () => {
    const service = new StorageUrlService(
      buildConfig({ 'storage.cdnBaseUrl': 'https://cdn.example.com/' }),
    );

    expect(service.buildUrl('/product_image/a.webp')).toBe(
      'https://cdn.example.com/product_image/a.webp',
    );
  });

  it('falls back to the key when no provider URL is supplied', () => {
    const service = new StorageUrlService(buildConfig());

    expect(service.buildUrl('a/b.webp')).toBe('a/b.webp');
  });

  it('treats an empty CDN_BASE_URL as unset', () => {
    const service = new StorageUrlService(
      buildConfig({ 'storage.cdnBaseUrl': '   ' }),
    );

    expect(service.cdnBaseUrl).toBeNull();
    expect(service.buildUrl('a/b.webp', '/uploads/a/b.webp')).toBe(
      '/uploads/a/b.webp',
    );
  });

  it('reads a root-level CDN_BASE_URL when the namespaced value is absent', () => {
    const service = new StorageUrlService({
      get: (key: string) =>
        key === 'CDN_BASE_URL' ? 'https://edge.example.com' : undefined,
    } as unknown as ConfigService);

    expect(service.buildUrl('a/b.webp')).toBe('https://edge.example.com/a/b.webp');
  });
});
