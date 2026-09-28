import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as getS3SignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageProvider } from '../interfaces/storage-provider.interface';

@Injectable()
export class S3StorageProvider implements StorageProvider {
  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly region: string;
  private readonly forcePathStyle: boolean;

  constructor(private readonly configService: ConfigService) {
    this.bucket = this.configService.get<string>('storage.s3.bucket') as string;
    this.region =
      this.configService.get<string>('storage.s3.region') ?? 'us-east-1';
    this.forcePathStyle =
      this.configService.get<boolean>('storage.s3.forcePathStyle') ?? false;

    if (!this.bucket) {
      throw new Error('AWS_S3_BUCKET is required when STORAGE_DRIVER=s3');
    }

    this.client = new S3Client({
      region: this.region,
      forcePathStyle: this.forcePathStyle,
      credentials: {
        accessKeyId:
          this.configService.get<string>('storage.s3.accessKeyId') ?? '',
        secretAccessKey:
          this.configService.get<string>('storage.s3.secretAccessKey') ?? '',
      },
    });
  }

  async upload(
    file: Express.Multer.File,
    filePath: string,
  ): Promise<{ url: string; key: string }> {
    const key = filePath.replace(/^\/+/, '');

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }),
    );

    this.logger.log(`Uploaded to S3: ${key}`);

    const url = this.forcePathStyle
      ? `https://s3.${this.region}.amazonaws.com/${this.bucket}/${key}`
      : `https://${this.bucket}.s3.${this.region}.amazonaws.com/${key}`;

    return { url, key };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key.replace(/^\/+/, ''),
      }),
    );
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<string> {
    return getS3SignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key.replace(/^\/+/, ''),
      }),
      { expiresIn: expiresInSeconds },
    );
  }
}
