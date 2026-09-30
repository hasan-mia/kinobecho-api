import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { StorageDriver } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { STORAGE_DRIVER_NAME, STORAGE_PROVIDER } from './storage.constants';
import { StorageProvider } from './interfaces/storage-provider.interface';
import { StorageUrlService } from './storage-url.service';
import { ImageProcessorService, VariantLabel } from './image-processor.service';

export const ALLOWED_MIME_SIZES: Record<string, number> = {
  'image/jpeg': 5 * 1024 * 1024,
  'image/png': 5 * 1024 * 1024,
  'image/webp': 5 * 1024 * 1024,
  'application/pdf': 10 * 1024 * 1024,
};

export interface RegisterFileInput {
  driver: StorageDriver;
  key: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  ownerType: string;
  ownerId: string;
  vendorId?: string;
  uploadedById?: string;
}

/** Public URL of every generated variant, plus the source dimensions. */
export interface UploadedImageVariants {
  url: string;
  mediumUrl: string;
  thumbUrl: string;
  width: number;
  height: number;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider,
    @Inject(STORAGE_DRIVER_NAME) private readonly driver: StorageDriver,
    private readonly urls: StorageUrlService,
    private readonly images: ImageProcessorService,
  ) {}

  get activeProvider(): StorageProvider {
    return this.provider;
  }

  async uploadFile(
    file: Express.Multer.File,
    path: string,
    input: {
      ownerType: string;
      ownerId: string;
      vendorId?: string;
      uploadedById?: string;
    },
  ) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    this.validateFile(file);

    const { url, key } = await this.provider.upload(file, path);

    return this.registerFile({
      driver: this.driver,
      key,
      url,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      vendorId: input.vendorId,
      uploadedById: input.uploadedById,
    });
  }

  async registerFile(input: RegisterFileInput) {
    return this.prisma.storageFile.create({
      data: {
        driver: this.driver,
        bucketKey: input.key,
        // The stored URL is the public one, so a CDN origin applies here rather
        // than in every read path.
        url: this.urls.buildUrl(input.key, input.url),
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        vendorId: input.vendorId ?? null,
        uploadedById: input.uploadedById ?? null,
      },
    });
  }

  /**
   * Uploads an image and every responsive variant, returning all URLs at once.
   *
   * The variants are generated inline — a product row is never left pointing at
   * a half-uploaded set — and the returned shape matches what
   * `ProductImage` persists. `url` is the 1200px variant.
   */
  async uploadImageVariants(
    file: Express.Multer.File,
    input: {
      ownerType: string;
      ownerId: string;
      vendorId?: string;
      uploadedById?: string;
    },
  ): Promise<UploadedImageVariants> {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    this.validateFile(file);

    // Rejects oversized bytes and oversized dimensions before any decode/encode.
    await this.images.validate(file.buffer);

    const processed = await this.images.process(file.buffer);

    const byLabel = new Map(processed.variants.map((v) => [v.label, v]));

    const uploadVariant = async (label: VariantLabel) => {
      const variant = byLabel.get(label)!;
      const key = this.images.buildVariantKey(input.ownerType, input.ownerId, variant);

      // The provider takes an Express.Multer.File; a variant is just bytes, so it
      // is handed over in the same envelope rather than widening the interface.
      const pseudoFile = {
        buffer: variant.buffer,
        mimetype: 'image/webp',
        size: variant.sizeBytes,
        originalname: `${label}.webp`,
      } as unknown as Express.Multer.File;

      const { url } = await this.provider.upload(pseudoFile, key);

      await this.registerFile({
        driver: this.driver,
        key,
        url,
        mimeType: 'image/webp',
        sizeBytes: variant.sizeBytes,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        vendorId: input.vendorId,
        uploadedById: input.uploadedById,
      });

      return this.urls.buildUrl(key, url);
    };

    const [large, medium, thumb] = await Promise.all([
      uploadVariant('large'),
      uploadVariant('medium'),
      uploadVariant('thumb'),
    ]);

    return {
      url: large,
      mediumUrl: medium,
      thumbUrl: thumb,
      width: processed.sourceWidth,
      height: processed.sourceHeight,
    };
  }

  async deleteFile(storageFileId: string) {
    const file = await this.prisma.storageFile.findUnique({
      where: { id: storageFileId },
    });

    if (!file) {
      return { message: 'File record not found' };
    }

    try {
      await this.provider.delete(file.bucketKey);
    } catch (error) {
      this.logger.warn(
        `Failed to remove object ${file.bucketKey}: ${(error as Error).message}`,
      );
    }

    await this.prisma.storageFile.delete({ where: { id: file.id } });

    return { message: 'File deleted' };
  }

  async deleteByKey(key: string) {
    try {
      await this.provider.delete(key);
    } catch (error) {
      this.logger.warn(
        `Failed to remove object ${key}: ${(error as Error).message}`,
      );
    }

    await this.prisma.storageFile.deleteMany({ where: { bucketKey: key } });
  }

  async getSignedUrl(key: string, expiresInSeconds = 900) {
    return this.provider.getSignedUrl(key, expiresInSeconds);
  }

  async getSignedUrlForFile(id: string, expiresInSeconds = 900) {
    const file = await this.prisma.storageFile.findUnique({
      where: { id },
    });

    if (!file) {
      throw new NotFoundException('File not found');
    }

    return {
      id: file.id,
      url: await this.provider.getSignedUrl(file.bucketKey, expiresInSeconds),
      expiresIn: expiresInSeconds,
    };
  }

  private validateFile(file: Express.Multer.File) {
    const maxBytes = ALLOWED_MIME_SIZES[file.mimetype];

    if (!maxBytes) {
      throw new BadRequestException(
        'Unsupported file type. Allowed: image/jpeg, image/png, image/webp, application/pdf',
      );
    }

    if (file.size > maxBytes) {
      throw new BadRequestException(
        `File too large. Max ${maxBytes / (1024 * 1024)}MB`,
      );
    }
  }
}
