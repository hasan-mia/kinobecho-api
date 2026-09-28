export interface StorageProvider {
  upload(file: Express.Multer.File, path: string): Promise<{ url: string; key: string }>;
  delete(key: string): Promise<void>;
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
}
