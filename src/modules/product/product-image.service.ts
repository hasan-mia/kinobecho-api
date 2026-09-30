import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { StorageService } from '../storage/storage.service';
import { buildStoragePath } from '../storage/storage-path.util';

@Injectable()
export class ProductImageService {
  private readonly logger = new Logger(ProductImageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async addImages(
    user: AuthenticatedUser,
    productId: string,
    files: Express.Multer.File[],
  ) {
    const product = await this.assertOwnProduct(user, productId);

    if (!files?.length) {
      throw new BadRequestException('At least one file is required');
    }

    const existing = await this.prisma.productImage.count({
      where: { productId: product.id },
    });

    const created: Prisma.ProductImageCreateManyInput[] = [];

    for (const [index, file] of files.entries()) {
      // One call produces the 1200/600/200 WebP set and registers each as a
      // StorageFile row, so a product never points at a partially uploaded set.
      const uploaded = await this.storage.uploadImageVariants(file, {
        ownerType: 'PRODUCT_IMAGE',
        ownerId: product.id,
        uploadedById: user.id,
      });

      created.push({
        productId: product.id,
        url: uploaded.url,
        thumbUrl: uploaded.thumbUrl,
        mediumUrl: uploaded.mediumUrl,
        width: uploaded.width,
        height: uploaded.height,
        isPrimary: existing === 0 && index === 0,
        sortOrder: existing + index,
      });
    }

    return this.prisma.productImage.createMany({ data: created });
  }

  async setPrimary(
    user: AuthenticatedUser,
    productId: string,
    imageId: string,
  ) {
    const product = await this.assertOwnProduct(user, productId);

    const image = await this.prisma.productImage.findUnique({
      where: { id: imageId },
    });

    if (!image || image.productId !== product.id) {
      throw new NotFoundException('Image not found');
    }

    await this.prisma.$transaction([
      this.prisma.productImage.updateMany({
        where: { productId: product.id },
        data: { isPrimary: false },
      }),
      this.prisma.productImage.update({
        where: { id: image.id },
        data: { isPrimary: true },
      }),
    ]);

    return this.prisma.productImage.findUniqueOrThrow({
      where: { id: image.id },
    });
  }

  async remove(user: AuthenticatedUser, productId: string, imageId: string) {
    const product = await this.assertOwnProduct(user, productId);

    const image = await this.prisma.productImage.findUnique({
      where: { id: imageId },
    });

    if (!image || image.productId !== product.id) {
      throw new NotFoundException('Image not found');
    }

    // All three variants are storage objects; leaving the 200px and 600px copies
    // behind would leak objects for every image ever removed.
    await this.removeStoredFiles([
      image.url,
      image.mediumUrl,
      image.thumbUrl,
    ]);

    await this.prisma.productImage.delete({ where: { id: image.id } });

    if (image.isPrimary) {
      const next = await this.prisma.productImage.findFirst({
        where: { productId: product.id },
        orderBy: { sortOrder: 'asc' },
        select: { id: true },
      });

      if (next) {
        await this.prisma.productImage.update({
          where: { id: next.id },
          data: { isPrimary: true },
        });
      }
    }

    return { message: 'Image deleted' };
  }

  private async removeStoredFiles(urls: (string | null)[]) {
    for (const url of urls) {
      if (!url) {
        continue;
      }

      const stored = await this.prisma.storageFile.findFirst({
        where: { url },
        select: { id: true },
      });

      if (stored) {
        await this.storage.deleteFile(stored.id);
        continue;
      }

      this.logger.warn(`No StorageFile row found for ${url}`);
    }
  }

  private async assertOwnProduct(
    user: AuthenticatedUser,
    productId: string,
  ) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const isAdmin =
      user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN;

    if (isAdmin) {
      return product;
    }

    if (!user.vendor || product.vendorId !== user.vendor.id) {
      throw new ForbiddenException('You can only manage your own products');
    }

    return product;
  }
}
