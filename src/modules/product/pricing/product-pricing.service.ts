import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  FlashSaleItemStatus,
  Prisma,
  SaleType,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

export interface ResolvedPrice {
  unitPrice: Prisma.Decimal;
  /** The flash sale item this price came from, or null for ordinary pricing. */
  flashSaleItemId: string | null;
}

@Injectable()
export class ProductPricingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves the unit price for a quantity server-side. Never trusts a price
   * supplied by the client.
   *
   * A live flash sale is checked first: the sale price is the whole reason the
   * buyer is here, and a tier rule would otherwise quietly override it.
   */
  async resolveUnitPrice(productId: string, qty: number): Promise<Prisma.Decimal> {
    return (await this.resolveWithContext(productId, qty)).unitPrice;
  }

  /**
   * Same price, but reports *which* flash sale produced it.
   *
   * Checkout needs the item id to increment `soldCount` and enforce
   * `perUserLimit`; every other caller only wants the number. Returning the
   * context here keeps one implementation rather than two that could drift.
   */
  async resolveWithContext(
    productId: string,
    qty: number,
    variantId?: string | null,
  ): Promise<ResolvedPrice> {
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new BadRequestException('Quantity must be a positive integer');
    }

    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: {
        id: true,
        price: true,
        saleType: true,
        minOrderQty: true,
        priceTiers: {
          orderBy: { minQty: 'asc' },
          select: { minQty: true, maxQty: true, unitPrice: true },
        },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const saleItem = await this.findActiveFlashSaleItem(product.id, variantId);

    if (saleItem) {
      // A wholesale-only product can be on sale: the sale price is the whole
      // point of the promotion and the tier rules do not apply to it.
      return { unitPrice: saleItem.salePrice, flashSaleItemId: saleItem.id };
    }

    const tier = product.priceTiers.find(
      (t) => qty >= t.minQty && (t.maxQty === null || qty <= t.maxQty),
    );

    if (tier) {
      return { unitPrice: tier.unitPrice, flashSaleItemId: null };
    }

    if (
      product.saleType === SaleType.RETAIL ||
      product.saleType === SaleType.BOTH
    ) {
      return { unitPrice: product.price, flashSaleItemId: null };
    }

    throw new BadRequestException(
      'Quantity does not meet minimum order requirement',
    );
  }

  /**
   * Finds the approved, live, unexhausted sale item covering a product.
   *
   * A product-level item (`variantId: null`) is a wildcard that covers any
   * variant, so a specific-variant item wins when both exist — the narrower
   * discount is the one the vendor specifically negotiated for that variant.
   * `soldCount < stockLimit` is filtered in memory because Prisma cannot compare
   * two columns, and the candidate set is one product's approved items.
   */
  private async findActiveFlashSaleItem(
    productId: string,
    variantId?: string | null,
  ): Promise<{ id: string; salePrice: Prisma.Decimal } | null> {
    const now = new Date();

    const items = await this.prisma.flashSaleItem.findMany({
      where: {
        productId,
        status: FlashSaleItemStatus.APPROVED,
        OR: [{ variantId: null }, ...(variantId ? [{ variantId }] : [])],
        flashSale: {
          isActive: true,
          startsAt: { lte: now },
          endsAt: { gte: now },
        },
      },
      select: {
        id: true,
        salePrice: true,
        variantId: true,
        stockLimit: true,
        soldCount: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const available = items.filter((item) => item.soldCount < item.stockLimit);

    if (available.length === 0) {
      return null;
    }

    // Specific variant beats the product-level wildcard, as described above.
    const specific = variantId
      ? available.find((item) => item.variantId === variantId)
      : undefined;

    const chosen = specific ?? available[0]!;

    return { id: chosen.id, salePrice: chosen.salePrice };
  }

  /**
   * Validates a quantity against the product's minimum order quantity and
   * resolves its unit price in a single query.
   */
  async resolveForQuantity(
    productId: string,
    qty: number,
  ): Promise<{ unitPrice: Prisma.Decimal; minOrderQty: number | null }> {
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new BadRequestException('Quantity must be a positive integer');
    }

    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: {
        id: true,
        price: true,
        saleType: true,
        minOrderQty: true,
        priceTiers: {
          orderBy: { minQty: 'asc' },
          select: { minQty: true, maxQty: true, unitPrice: true },
        },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.minOrderQty && qty < product.minOrderQty) {
      throw new BadRequestException(
        `Minimum order quantity for this product is ${product.minOrderQty}`,
      );
    }

    const tier = product.priceTiers.find(
      (t) => qty >= t.minQty && (t.maxQty === null || qty <= t.maxQty),
    );

    if (tier) {
      return { unitPrice: tier.unitPrice, minOrderQty: product.minOrderQty };
    }

    if (
      product.saleType === SaleType.RETAIL ||
      product.saleType === SaleType.BOTH
    ) {
      return { unitPrice: product.price, minOrderQty: product.minOrderQty };
    }

    throw new BadRequestException(
      'Quantity does not meet minimum order requirement',
    );
  }
}
