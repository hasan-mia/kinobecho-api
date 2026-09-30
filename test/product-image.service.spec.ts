import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma, UserRole } from '@prisma/client';
import { ProductImageService } from '../src/modules/product/product-image.service';
import { StorageService } from '../src/modules/storage/storage.service';
import { PrismaService } from '../src/database/prisma.service';
import { AuthenticatedUser } from '../src/common/guards/roles.guard';

/**
 * The upload path must persist the variant URLs and source dimensions, and a
 * removal must take all three stored objects with it — leaving the 200px and
 * 600px copies behind would leak an object per deleted image.
 */
describe('ProductImageService variants', () => {
  let prisma: {
    product: { findFirst: ReturnType<typeof vi.fn> };
    productImage: {
      count: ReturnType<typeof vi.fn>;
      createMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    storageFile: { findFirst: ReturnType<typeof vi.fn> };
  };
  let storage: {
    uploadImageVariants: ReturnType<typeof vi.fn>;
    deleteFile: ReturnType<typeof vi.fn>;
  };
  let service: ProductImageService;

  const vendor = {
    id: 'u1',
    email: 'v@example.com',
    name: 'Vendor',
    role: UserRole.VENDOR,
    roleId: null,
    vendor: { id: 'vendor-1' },
  } as unknown as AuthenticatedUser;

  const multerFile = (name: string) =>
    ({ originalname: name, mimetype: 'image/jpeg' }) as unknown as Express.Multer.File;

  beforeEach(() => {
    prisma = {
      product: {
        findFirst: vi.fn().mockResolvedValue({ id: 'product-1', vendorId: 'vendor-1' }),
      },
      productImage: {
        count: vi.fn().mockResolvedValue(0),
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn(),
        delete: vi.fn().mockResolvedValue({}),
        findFirst: vi.fn().mockResolvedValue(null),
        update: vi.fn().mockResolvedValue({}),
      },
      storageFile: { findFirst: vi.fn().mockResolvedValue(null) },
    };

    storage = {
      uploadImageVariants: vi.fn().mockResolvedValue({
        url: 'https://cdn.example.com/product_image/large.webp',
        mediumUrl: 'https://cdn.example.com/product_image/medium.webp',
        thumbUrl: 'https://cdn.example.com/product_image/thumb.webp',
        width: 1600,
        height: 1200,
      }),
      deleteFile: vi.fn().mockResolvedValue({}),
    };

    service = new ProductImageService(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
    );
  });

  it('persists thumb, medium, width and height alongside url', async () => {
    await service.addImages(vendor, 'product-1', [multerFile('a.jpg')]);

    const { data } = prisma.productImage.createMany.mock.calls[0]![0] as {
      data: Prisma.ProductImageCreateManyInput[];
    };

    expect(data[0]).toMatchObject({
      productId: 'product-1',
      url: 'https://cdn.example.com/product_image/large.webp',
      thumbUrl: 'https://cdn.example.com/product_image/thumb.webp',
      mediumUrl: 'https://cdn.example.com/product_image/medium.webp',
      width: 1600,
      height: 1200,
    });
  });

  it('delegates to the variant upload rather than a single-file upload', async () => {
    await service.addImages(vendor, 'product-1', [multerFile('a.jpg')]);

    expect(storage.uploadImageVariants).toHaveBeenCalledWith(
      expect.objectContaining({ mimetype: 'image/jpeg' }),
      { ownerType: 'PRODUCT_IMAGE', ownerId: 'product-1', uploadedById: 'u1' },
    );
  });

  it('marks the first image of the first batch as primary', async () => {
    await service.addImages(vendor, 'product-1', [multerFile('a.jpg')]);

    const { data } = prisma.productImage.createMany.mock.calls[0]![0] as {
      data: Prisma.ProductImageCreateManyInput[];
    };

    expect(data[0]!.isPrimary).toBe(true);
    expect(data[0]!.sortOrder).toBe(0);
  });

  it('deletes all three variant objects when an image is removed', async () => {
    prisma.productImage.findUnique.mockResolvedValue({
      id: 'img-1',
      productId: 'product-1',
      url: 'https://cdn.example.com/large.webp',
      mediumUrl: 'https://cdn.example.com/medium.webp',
      thumbUrl: 'https://cdn.example.com/thumb.webp',
      isPrimary: false,
    });

    prisma.storageFile.findFirst
      .mockResolvedValueOnce({ id: 'sf-large' })
      .mockResolvedValueOnce({ id: 'sf-medium' })
      .mockResolvedValueOnce({ id: 'sf-thumb' });

    await service.remove(vendor, 'product-1', 'img-1');

    // All three, not just the 1200px original.
    expect(storage.deleteFile).toHaveBeenCalledTimes(3);
    expect(storage.deleteFile).toHaveBeenCalledWith('sf-large');
    expect(storage.deleteFile).toHaveBeenCalledWith('sf-medium');
    expect(storage.deleteFile).toHaveBeenCalledWith('sf-thumb');
  });

  it('tolerates legacy rows that have no variants yet', async () => {
    prisma.productImage.findUnique.mockResolvedValue({
      id: 'img-legacy',
      productId: 'product-1',
      url: '/uploads/legacy.png',
      mediumUrl: null,
      thumbUrl: null,
      isPrimary: false,
    });
    prisma.storageFile.findFirst.mockResolvedValue({ id: 'sf-legacy' });

    await service.remove(vendor, 'product-1', 'img-legacy');

    // Only the one object that exists is removed; no crash on the null variants.
    expect(storage.deleteFile).toHaveBeenCalledTimes(1);
    expect(storage.deleteFile).toHaveBeenCalledWith('sf-legacy');
  });
});
