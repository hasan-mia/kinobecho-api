import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProductStatus, SaleType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ProductPricingService } from '../product/pricing/product-pricing.service';
import { AddCartItemDto, UpdateCartItemDto } from './dto/cart.dto';

interface FlashSaleInfo {
  itemId: string;
  salePrice: Prisma.Decimal;
  normalPrice: Prisma.Decimal;
  remaining: number;
  endsAt: Date;
}

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: ProductPricingService,
  ) {}

  async getCart(userId: string) {
    const cart = await this.getOrCreateCart(userId);

    const items = await this.prisma.cartItem.findMany({
      where: { cartId: cart.id },
      orderBy: { createdAt: 'asc' },
      include: {
        product: {
          include: {
            images: { where: { isPrimary: true }, take: 1 },
            vendor: { select: { id: true, businessName: true, slug: true } },
          },
        },
        productVariant: true,
      },
    });

    let subtotal = new Prisma.Decimal(0);
    const resolved = [];

    for (const item of items) {
      let unitPrice: Prisma.Decimal;
      let priceError: string | null = null;
      let flashSaleItemId: string | null = null;
      let flashSale: FlashSaleInfo | null = null;

      try {
        // With the variant so a variant-scoped sale price is found, and with the
        // context so the cart can show what the buyer is saving and how much of
        // the sale budget is left — a cart that shows the discounted price
        // without saying "3 left" invites a checkout that then fails.
        const priced = await this.pricing.resolveWithContext(
          item.productId,
          item.qty,
          item.productVariantId,
        );
        unitPrice = priced.unitPrice;
        flashSaleItemId = priced.flashSaleItemId;
      } catch (error) {
        priceError = (error as Error).message;
        unitPrice = item.productVariant?.priceOverride ?? item.product.price;
      }

      if (flashSaleItemId) {
        flashSale = await this.describeFlashSaleItem(flashSaleItemId);
      }

      const lineTotal = unitPrice.mul(item.qty);
      subtotal = subtotal.add(lineTotal);

      resolved.push({
        id: item.id,
        qty: item.qty,
        unitPrice,
        lineTotal,
        priceError,
        ...(flashSale
          ? {
              flashSale: {
                itemId: flashSale.itemId,
                salePrice: flashSale.salePrice,
                normalPrice: flashSale.normalPrice,
                remaining: flashSale.remaining,
                endsAt: flashSale.endsAt,
                // False when the budget or the per-buyer allowance cannot cover
                // this line, so the UI can disable checkout for it rather than
                // letting the customer discover it at the last step.
                purchasable: flashSale.remaining >= item.qty,
              },
            }
          : {}),
        product: item.product,
        productVariant: item.productVariant,
      });
    }

    return {
      id: cart.id,
      items: resolved,
      totals: {
        itemCount: items.reduce((sum, item) => sum + item.qty, 0),
        subtotal,
      },
    };
  }

  /**
   * Loads the sale facts a cart line needs to render, in one query.
   *
   * The buyer's own holdings are counted too, because `perUserLimit` is a real
   * constraint: a second cart line for the same sale item can be within the
   * budget and still be unbuyable by this customer.
   */
  private async describeFlashSaleItem(
    flashSaleItemId: string,
  ): Promise<FlashSaleInfo | null> {
    const item = await this.prisma.flashSaleItem.findUnique({
      where: { id: flashSaleItemId },
      select: {
        id: true,
        salePrice: true,
        stockLimit: true,
        soldCount: true,
        perUserLimit: true,
        product: { select: { price: true } },
        flashSale: { select: { endsAt: true } },
      },
    });

    if (!item) {
      return null;
    }

    return {
      itemId: item.id,
      salePrice: item.salePrice,
      normalPrice: item.product.price,
      remaining: Math.max(item.stockLimit - item.soldCount, 0),
      endsAt: item.flashSale.endsAt,
    };
  }

  async addItem(userId: string, dto: AddCartItemDto) {
    const product = await this.prisma.product.findFirst({
      where: { id: dto.productId, deletedAt: null },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.status !== ProductStatus.ACTIVE) {
      throw new BadRequestException('Product is not available');
    }

    const cart = await this.getOrCreateCart(userId);

    // @@unique([cartId, productId, productVariantId]) does NOT cover rows with a
    // NULL productVariantId (PostgreSQL treats NULLs as distinct), so duplicates
    // for variant-less products must be merged in the service. The lookup and the
    // write happen in one transaction so two concurrent adds cannot both miss.
    const item = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.cartItem.findFirst({
        where: {
          cartId: cart.id,
          productId: product.id,
          productVariantId: dto.productVariantId ?? null,
        },
      });

      const finalQty = (existing?.qty ?? 0) + dto.qty;

      if (dto.productVariantId) {
        const variant = await tx.productVariant.findUnique({
          where: { id: dto.productVariantId },
        });

        if (!variant || variant.productId !== product.id) {
          throw new NotFoundException('Product variant not found');
        }

        if (variant.stock < finalQty) {
          throw new BadRequestException('Insufficient stock for the selected variant');
        }
      }

      if (
        product.saleType === SaleType.WHOLESALE &&
        product.minOrderQty &&
        finalQty < product.minOrderQty
      ) {
        throw new BadRequestException(
          `Minimum order quantity for this product is ${product.minOrderQty}`,
        );
      }

      await this.pricing.resolveForQuantity(product.id, finalQty);

      if (existing) {
        return tx.cartItem.update({
          where: { id: existing.id },
          data: { qty: finalQty },
        });
      }

      return tx.cartItem.create({
        data: {
          cartId: cart.id,
          productId: product.id,
          productVariantId: dto.productVariantId ?? null,
          qty: dto.qty,
        },
      });
    });

    return { item, cart: await this.getCart(userId) };
  }

  async updateItem(userId: string, itemId: string, dto: UpdateCartItemDto) {
    const item = await this.findOwnItem(userId, itemId);

    const product = await this.prisma.product.findFirst({
      where: { id: item.productId, deletedAt: null },
      select: { id: true, saleType: true, minOrderQty: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (
      product.saleType === SaleType.WHOLESALE &&
      product.minOrderQty &&
      dto.qty < product.minOrderQty
    ) {
      throw new BadRequestException(
        `Minimum order quantity for this product is ${product.minOrderQty}`,
      );
    }

    await this.pricing.resolveForQuantity(item.productId, dto.qty);

    if (item.productVariantId) {
      const variant = await this.prisma.productVariant.findUnique({
        where: { id: item.productVariantId },
      });

      if (!variant || variant.stock < dto.qty) {
        throw new BadRequestException('Insufficient stock for the selected variant');
      }
    }

    await this.prisma.cartItem.update({
      where: { id: item.id },
      data: { qty: dto.qty },
    });

    return this.getCart(userId);
  }

  async removeItem(userId: string, itemId: string) {
    const item = await this.findOwnItem(userId, itemId);

    await this.prisma.cartItem.delete({ where: { id: item.id } });

    return this.getCart(userId);
  }

  async clear(userId: string) {
    const cart = await this.getOrCreateCart(userId);

    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id } });

    return { message: 'Cart cleared' };
  }

  private async getOrCreateCart(userId: string) {
    const existing = await this.prisma.cart.findUnique({
      where: { userId },
    });

    if (existing) {
      return existing;
    }

    return this.prisma.cart.create({ data: { userId } });
  }

  private async findOwnItem(userId: string, itemId: string) {
    const item = await this.prisma.cartItem.findUnique({
      where: { id: itemId },
      include: { cart: { select: { userId: true } } },
    });

    if (!item) {
      throw new NotFoundException('Cart item not found');
    }

    if (item.cart.userId !== userId) {
      throw new ForbiddenException('This cart item belongs to another user');
    }

    return item;
  }
}
