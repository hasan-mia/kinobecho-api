import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage } from '@google-cloud/storage';
import { StorageProvider } from '../interfaces/storage-provider.interface';

@Injectable()
export class GcsStorageProvider implements StorageProvider {
  private readonly logger = new Logger(GcsStorageProvider.name);
  private readonly storage: Storage;
  private readonly bucketName: string;

  constructor(private readonly configService: ConfigService) {
    this.bucketName = this.configService.get<string>('storage.gcs.bucket') as string;

    if (!this.bucketName) {
      throw new Error('GCP_BUCKET is required when STORAGE_DRIVER=gcs');
    }

    const projectId =
      this.configService.get<string>('storage.gcs.projectId') ?? undefined;
    const credentialsBase64 =
      this.configService.get<string>('storage.gcs.credentialsBase64') ??
      this.configService.get<string>('GCP_CREDENTIALS_BASE64');

    const credentials = credentialsBase64
      ? JSON.parse(Buffer.from(credentialsBase64, 'base64').toString('utf8'))
      : undefined;

    this.storage = new Storage({
      projectId,
      credentials,
    });
  }

  async upload(
    file: Express.Multer.File,
    filePath: string,
  ): Promise<{ url: string; key: string }> {
    const key = filePath.replace(/^\/+/, '');
    const fileHandle = this.storage.bucket(this.bucketName).file(key);

    await fileHandle.save(file.buffer, {
      contentType: file.mimetype,
      resumable: false,
    });

    this.logger.log(`Uploaded to GCS: ${key}`);

    return {
      url: `https://storage.googleapis.com/${this.bucketName}/${key}`,
      key,
    };
  }

  async delete(key: string): Promise<void> {
    await this.storage
      .bucket(this.bucketName)
      .file(key.replace(/^\/+/, ''))
      .delete({ ignoreNotFound: true });
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const [url] = await this.storage
      .bucket(this.bucketName)
      .file(key.replace(/^\/+/, ''))
      .getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + expiresInSeconds * 1000,
      });

    return url;
  }
}
