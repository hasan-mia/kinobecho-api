import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SaleType } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class ProductPricingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolves the unit price for a quantity server-side. Never trusts a price
   * supplied by the client.
   */
  async resolveUnitPrice(productId: string, qty: number): Promise<Prisma.Decimal> {
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

    const tier = product.priceTiers.find(
      (t) => qty >= t.minQty && (t.maxQty === null || qty <= t.maxQty),
    );

    if (tier) {
      return tier.unitPrice;
    }

    if (
      product.saleType === SaleType.RETAIL ||
      product.saleType === SaleType.BOTH
    ) {
      return product.price;
    }

    throw new BadRequestException(
      'Quantity does not meet minimum order requirement',
    );
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
