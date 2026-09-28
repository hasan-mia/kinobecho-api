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

      try {
        unitPrice = await this.pricing.resolveUnitPrice(
          item.productId,
          item.qty,
        );
      } catch (error) {
        priceError = (error as Error).message;
        unitPrice = item.productVariant?.priceOverride ?? item.product.price;
      }

      const lineTotal = unitPrice.mul(item.qty);
      subtotal = subtotal.add(lineTotal);

      resolved.push({
        id: item.id,
        qty: item.qty,
        unitPrice,
        lineTotal,
        priceError,
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

    if (dto.productVariantId) {
      const variant = await this.prisma.productVariant.findUnique({
        where: { id: dto.productVariantId },
      });

      if (!variant || variant.productId !== product.id) {
        throw new NotFoundException('Product variant not found');
      }

      if (variant.stock < dto.qty) {
        throw new BadRequestException('Insufficient stock for the selected variant');
      }
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

    await this.pricing.resolveForQuantity(product.id, dto.qty);

    const cart = await this.getOrCreateCart(userId);

    const existing = await this.prisma.cartItem.findFirst({
      where: {
        cartId: cart.id,
        productId: product.id,
        productVariantId: dto.productVariantId ?? null,
      },
    });

    if (existing) {
      const nextQty = existing.qty + dto.qty;
      await this.pricing.resolveForQuantity(product.id, nextQty);

      const updated = await this.prisma.cartItem.update({
        where: { id: existing.id },
        data: { qty: nextQty },
      });

      return this.getCart(userId).then((cart) => ({
        item: updated,
        cart,
      }));
    }

    const item = await this.prisma.cartItem.create({
      data: {
        cartId: cart.id,
        productId: product.id,
        productVariantId: dto.productVariantId ?? null,
        qty: dto.qty,
      },
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
