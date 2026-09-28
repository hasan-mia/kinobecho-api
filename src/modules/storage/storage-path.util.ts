import { createHash } from 'node:crypto';
import * as path from 'node:path';

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

export function buildStoragePath(
  ownerType: string,
  ownerId: string,
  file: Express.Multer.File,
): string {
  const extension =
    EXTENSION_BY_MIME[file.mimetype] ?? path.extname(file.originalname) ?? '';
  const checksum = createHash('sha256')
    .update(file.buffer)
    .digest('hex')
    .slice(0, 16);

  const now = new Date();
  const datePart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  return path.posix.join(
    ownerType.toLowerCase(),
    datePart,
    `${ownerId}-${checksum}${extension}`,
  );
}
