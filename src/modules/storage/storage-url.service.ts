import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Builds the public URL for a stored object.
 *
 * Storage providers return a URL in whatever scheme they natively use — a local
 * `/uploads/…` path, an S3 or GCS host. When `CDN_BASE_URL` is configured the CDN
 * fronts the bucket instead, and every public URL becomes `CDN_BASE_URL + key`.
 * Centralising this keeps the CDN decision in one place instead of spread across
 * each provider.
 */
@Injectable()
export class StorageUrlService {
  constructor(private readonly configService: ConfigService) {}

  get cdnBaseUrl(): string | null {
    const configured =
      this.configService.get<string>('storage.cdnBaseUrl') ??
      this.configService.get<string>('CDN_BASE_URL') ??
      '';

    const trimmed = configured.trim().replace(/\/+$/, '');

    return trimmed.length > 0 ? trimmed : null;
  }

  /**
   * Prefixes a storage key with the CDN origin when one is configured.
   * Returns `key` untouched otherwise, so a local `/uploads/…` path or an
   * already-absolute provider URL is never mangled.
   */
  buildUrl(key: string, providerUrl?: string): string {
    const base = this.cdnBaseUrl;

    if (base) {
      return `${base}/${key.replace(/^\/+/, '')}`;
    }

    return providerUrl ?? key;
  }
}
