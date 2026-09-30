import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { createHash } from 'node:crypto';

/** Short, stable content hash used to make storage keys immutable. */
function checksumOf(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

/**
 * One responsive variant of an uploaded image.
 *
 * `label` is the on-disk size class, and `width`/`height` are the *actual*
 * encoded dimensions — which may be smaller than the target when the source is
 * smaller, because nothing here is ever upscaled.
 */
export interface ImageVariant {
  label: 'thumb' | 'medium' | 'large';
  buffer: Buffer;
  width: number;
  height: number;
  /** sha256 of the encoded bytes, truncated; forms the immutable part of the key. */
  checksum: string;
  sizeBytes: number;
}

export interface ProcessedImage {
  variants: ImageVariant[];
  /** Intrinsic dimensions of the source, before any resize. */
  sourceWidth: number;
  sourceHeight: number;
}

/** Largest edge, in pixels, for each variant. */
const VARIANT_WIDTHS = {
  thumb: 200,
  medium: 600,
  large: 1200,
} as const;

export type VariantLabel = keyof typeof VARIANT_WIDTHS;

export const VARIANT_ORDER: VariantLabel[] = ['thumb', 'medium', 'large'];

/**
 * Turns uploaded images into responsive WebP variants.
 *
 * Kept as its own service, with no knowledge of storage or the database, so the
 * resizing can move behind a queue later without touching its callers: the
 * signature only takes bytes and returns bytes.
 *
 * Two properties drive the design:
 *
 * - **Keys are content-addressed.** Each key embeds the checksum of the encoded
 *   variant, so re-uploading identical bytes produces the same key, and a changed
 *   key can never collide with an old one. That is what makes
 *   `Cache-Control: immutable` safe to serve.
 * - **Metadata is dropped.** `sharp` strips EXIF by default unless asked
 *   otherwise; a re-encode is enough to drop it, so a phone's GPS-tagged photo
 *   does not keep its location once uploaded.
 */
@Injectable()
export class ImageProcessorService {
  private readonly logger = new Logger(ImageProcessorService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Validates the upload before any decode work happens.
   *
   * The size check is a cheap byte-length test; the dimension check needs the
   * header, so a 5MB limit alone cannot stop a decompression bomb.
   */
  async validate(
    buffer: Buffer,
    declaredWidth?: number,
    declaredHeight?: number,
  ): Promise<{ width: number; height: number }> {
    const maxBytes = this.maxBytes();

    if (buffer.length > maxBytes) {
      throw new BadRequestException(
        `Image too large. Max ${Math.round(maxBytes / (1024 * 1024))}MB`,
      );
    }

    const maxDimension = this.maxDimension();

    if (
      declaredWidth !== undefined &&
      (declaredWidth > maxDimension || declaredHeight! > maxDimension)
    ) {
      throw new BadRequestException(
        `Image dimensions too large. Max ${maxDimension}px per side`,
      );
    }

    const metadata = await sharp(buffer).metadata();

    if (!metadata.width || !metadata.height) {
      throw new BadRequestException('Could not read image dimensions');
    }

    if (metadata.width > maxDimension || metadata.height > maxDimension) {
      throw new BadRequestException(
        `Image dimensions too large. Max ${maxDimension}px per side`,
      );
    }

    return { width: metadata.width, height: metadata.height };
  }

  /** Generates every variant for a validated image. */
  async process(buffer: Buffer): Promise<ProcessedImage> {
    const source = sharp(buffer);
    const metadata = await source.metadata();

    if (!metadata.width || !metadata.height) {
      throw new BadRequestException('Could not read image dimensions');
    }

    const variants: ImageVariant[] = [];

    for (const label of VARIANT_ORDER) {
      variants.push(
        await this.renderVariant(buffer, label, metadata.width, metadata.height),
      );
    }

    return {
      variants,
      sourceWidth: metadata.width,
      sourceHeight: metadata.height,
    };
  }

  private async renderVariant(
    buffer: Buffer,
    label: VariantLabel,
    sourceWidth: number,
    sourceHeight: number,
  ): Promise<ImageVariant> {
    // `rotate()` applies the EXIF orientation first, so a portrait photo saved
    // sideways is resized on its visual axes rather than its stored ones.
    // `withoutEnlargement` means a 300px-wide source yields a 200px thumb, never
    // a blurry 1200px upscale.
    const { data, info } = await sharp(buffer)
      .rotate()
      .resize({
        width: VARIANT_WIDTHS[label],
        withoutEnlargement: true,
      })
      .webp({ quality: this.quality() })
      .toBuffer({ resolveWithObject: true });

    return {
      label,
      buffer: data,
      width: info.width,
      height: info.height,
      checksum: checksumOf(data),
      sizeBytes: data.length,
    };
  }

  /**
   * Builds a storage key for one variant.
   *
   * `<owner>/<date>/<ownerId>-<variant>-<checksum>.webp` — the checksum makes
   * the key immutable, so a cached response can never go stale.
   */
  buildVariantKey(
    ownerType: string,
    ownerId: string,
    variant: ImageVariant,
    date: Date = new Date(),
  ): string {
    const datePart = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    return [
      ownerType.toLowerCase(),
      datePart,
      `${ownerId}-${variant.label}-${variant.checksum}.webp`,
    ].join('/');
  }

  private maxBytes(): number {
    return this.configService.get<number>('storage.image.maxBytes') ?? 5 * 1024 * 1024;
  }

  private maxDimension(): number {
    return this.configService.get<number>('storage.image.maxDimension') ?? 6000;
  }

  private quality(): number {
    return this.configService.get<number>('storage.image.quality') ?? 80;
  }
}
