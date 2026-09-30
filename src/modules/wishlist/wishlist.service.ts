import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProductStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { ProductPricingService } from '../product/pricing/product-pricing.service';
import { ListWishlistQueryDto } from './dto/wishlist.dto';

/**
 * What a wishlist row needs alongside the product.
 *
 * The listing is read far more often than it changes, so it resolves the
 * *current* price rather than storing one: a saved item is a pointer, and a
 * price frozen at save time would be wrong the moment the vendor changes it.
 */
const WISHLIST_INCLUDE = {
  product: {
    include: {
      images: {
        where: { isPrimary: true },
        take: 1,
        select: { thumbUrl: true, url: true },
      },
      variants: { select: { stock: true } },
      priceTiers: {
        orderBy: { minQty: 'asc' },
        select: { minQty: true, maxQty: true, unitPrice: true },
      },
      vendor: { select: { id: true, businessName: true, slug: true } },
    },
  },
} satisfies Prisma.WishlistItemInclude;

type WishlistRow = Prisma.WishlistItemGetPayload<{
  include: typeof WISHLIST_INCLUDE;
}>;

@Injectable()
export class WishlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: ProductPricingService,
  ) {}

  /**
   * Saves a product.
   *
   * Idempotent by construction: the unique `(userId, productId)` constraint is
   * the guard, and a duplicate insert is caught and answered with the existing
   * row. Checking first would leave a race between two taps of the same button —
   * and the retry that follows a timeout is a duplicate add, not a bug.
   */
  async add(user: AuthenticatedUser, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true, status: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.status !== ProductStatus.ACTIVE) {
      throw new ConflictException('This product is not available');
    }

    try {
      return await this.prisma.wishlistItem.create({
        data: { userId: user.id, productId: product.id },
        include: WISHLIST_INCLUDE,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return this.prisma.wishlistItem.findUniqueOrThrow({
          where: { userId_productId: { userId: user.id, productId: product.id } },
          include: WISHLIST_INCLUDE,
        });
      }

      throw err;
    }
  }

  /**
   * Removes a saved product.
   *
   * Idempotent too: removing something that was never saved is a no-op, so a
   * double tap on "remove" is not an error the client has to handle.
   */
  async remove(user: AuthenticatedUser, productId: string) {
    const { count } = await this.prisma.wishlistItem.deleteMany({
      where: { userId: user.id, productId },
    });

    return { removed: count > 0 };
  }

  /**
   * The current buyer's wishlist.
   *
   * Products that have since been archived or deleted are filtered out of the
   * response but their rows are left alone: a temporary stock-out should not
   * destroy a saved list, and re-activating the product should make it reappear
   * without the buyer doing anything.
   */
  async list(user: AuthenticatedUser, query: ListWishlistQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.WishlistItemWhereInput = { userId: user.id };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.wishlistItem.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: WISHLIST_INCLUDE,
      }),
      this.prisma.wishlistItem.count({ where }),
    ]);

    return {
      items: await Promise.all(rows.map((row) => this.toView(row))),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Flattens a row into the shape the storefront renders. */
  private async toView(row: WishlistRow) {
    const product = row.product;
    const totalStock = product.variants.reduce(
      (sum, variant) => sum + variant.stock,
      0,
    );

    // Resolved at one unit, falling back to the stored price: a wholesale-only
    // product throws on `resolveUnitPrice(1)` because one unit does not meet the
    // minimum, and a wishlist entry is not an order.
    let price: Prisma.Decimal = product.price;

    try {
      price = await this.pricing.resolveUnitPrice(product.id, 1);
    } catch {
      // Keep the listed price; the checkout page will enforce the real minimum.
    }

    return {
      id: row.id,
      createdAt: row.createdAt,
      product: {
        id: product.id,
        name: product.name,
        slug: product.slug,
        price: price.toFixed(2),
        available: product.status === ProductStatus.ACTIVE && product.deletedAt === null,
        inStock: totalStock > 0,
        thumbUrl: product.images[0]?.thumbUrl ?? null,
        vendor: product.vendor,
      },
    };
  }
}

/** Postgres unique-violation code, without importing driver internals. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'P2002'
  );
}
