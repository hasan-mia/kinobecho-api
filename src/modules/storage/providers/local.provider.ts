import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { StorageProvider } from '../interfaces/storage-provider.interface';

@Injectable()
export class LocalStorageProvider implements StorageProvider {
  private readonly logger = new Logger(LocalStorageProvider.name);
  private readonly baseDir: string;
  private readonly assetUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.baseDir = path.resolve(
      this.configService.get<string>('storage.localUploadPath') ??
        this.configService.get<string>('LOCAL_UPLOAD_PATH') ??
        'uploads',
    );
    this.assetUrl = (
      this.configService.get<string>('storage.localAssetUrl') ??
      this.configService.get<string>('LOCAL_ASSET_URL') ??
      '/uploads'
    ).replace(/\/$/, '');
  }

  async upload(
    file: Express.Multer.File,
    filePath: string,
  ): Promise<{ url: string; key: string }> {
    const safePath = filePath.replace(/^\/+/, '');
    const absolutePath = path.join(this.baseDir, safePath);
    const directory = path.dirname(absolutePath);

    if (!absolutePath.startsWith(this.baseDir)) {
      throw new Error('Invalid storage path');
    }

    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(absolutePath, file.buffer);

    this.logger.log(`Stored file locally: ${safePath}`);

    return { url: `${this.assetUrl}/${safePath}`, key: safePath };
  }

  async delete(key: string): Promise<void> {
    const absolutePath = path.join(this.baseDir, key.replace(/^\/+/, ''));

    if (!absolutePath.startsWith(this.baseDir)) {
      throw new Error('Invalid storage path');
    }

    await fs.rm(absolutePath, { force: true });
  }

  async getSignedUrl(key: string, _expiresInSeconds: number): Promise<string> {
    return `${this.assetUrl}/${key.replace(/^\/+/, '')}`;
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  static checksum(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  }
}
