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

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider,
    @Inject(STORAGE_DRIVER_NAME) private readonly driver: StorageDriver,
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
        driver: input.driver,
        bucketKey: input.key,
        url: input.url,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        vendorId: input.vendorId ?? null,
        uploadedById: input.uploadedById ?? null,
      },
    });
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
