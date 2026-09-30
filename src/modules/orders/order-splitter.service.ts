import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Order,
  OrderStatus,
  Prisma,
  SaleChannel,
  SaleType,
} from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { ProductPricingService } from '../product/pricing/product-pricing.service';
import { CouponsService } from '../coupons/coupons.service';
import { ShippingRateService } from '../shipping/shipping-rate.service';
import { LowStockService } from '../payouts/low-stock.service';
import { CheckoutDto } from './dto/order.dto';

type CartItemWithProduct = Prisma.CartItemGetPayload<{
  include: { product: true; productVariant: true };
}>;

interface DiscountPlan {
  perVendor: Map<string, Prisma.Decimal>;
  couponId: string | null;
}

interface VendorLine {
  productNameSnap: string;
  qty: number;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  productVariantId: string;
  saleChannel: SaleChannel;
}

@Injectable()
export class OrderSplitterService {
  private readonly logger = new Logger(OrderSplitterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: ProductPricingService,
    private readonly coupons: CouponsService,
    private readonly shipping: ShippingRateService,
    private readonly configService: ConfigService,
    private readonly lowStock: LowStockService,
  ) {}

  /** Config-driven fallback so a missing value still yields the documented 30. */
  private paymentTtlMinutes(): number {
    return this.configService.get<number>('order.paymentTtlMinutes') ?? 30;
  }

  async splitCartIntoOrders(
    userId: string,
    checkoutDto: CheckoutDto,
  ): Promise<Order[]> {
    const address = await this.prisma.address.findFirst({
      where: { id: checkoutDto.addressId, userId },
    });

    if (!address) {
      throw new NotFoundException('Shipping address not found');
    }

    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: { product: true, productVariant: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!cart || cart.items.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    const shippingAddress: Prisma.InputJsonValue = {
      recipientName: address.recipientName,
      phone: address.phone,
      line1: address.line1,
      line2: address.line2,
      city: address.city,
      district: address.district,
      postalCode: address.postalCode,
      country: address.country,
      label: address.label,
    };

    const groups = new Map<string, CartItemWithProduct[]>();
    for (const item of cart.items) {
      const group = groups.get(item.product.vendorId) ?? [];
      group.push(item);
      groups.set(item.product.vendorId, group);
    }

    const orderGroupId = randomBytes(16).toString('hex');
    const datePart = this.orderNumberDatePart();

    // Variant ids whose stock this checkout moved, checked for low-stock once
    // the transaction commits.
    const touchedVariantIds = new Set<string>();

    return this.prisma.$transaction(async (tx) => {
      const subtotals = new Map<string, Prisma.Decimal>();
      const linesByVendor = new Map<string, VendorLine[]>();
      let cartSubtotal = new Prisma.Decimal(0);

      for (const [vendorId, items] of groups) {
        const lines: VendorLine[] = [];
        let subtotal = new Prisma.Decimal(0);
        let allWholesale = true;

        for (const item of items) {
          if (!item.productVariantId || !item.productVariant) {
            throw new BadRequestException(
              `Product "${item.product.name}" has no selected variant`,
            );
          }

          if (item.productVariant.stock < item.qty) {
            throw new BadRequestException(
              `Insufficient stock for "${item.product.name}" (available: ${item.productVariant.stock})`,
            );
          }

          const unitPrice = await this.pricing.resolveUnitPrice(
            item.productId,
            item.qty,
          );
          const lineTotal = unitPrice.mul(item.qty);
          const saleChannel = this.resolveSaleChannel(item);

          if (saleChannel === SaleChannel.RETAIL) {
            allWholesale = false;
          }

          subtotal = subtotal.add(lineTotal);
          cartSubtotal = cartSubtotal.add(lineTotal);

          lines.push({
            productNameSnap: item.product.name,
            qty: item.qty,
            unitPrice,
            lineTotal,
            productVariantId: item.productVariantId,
            saleChannel,
          });
        }

        subtotals.set(vendorId, subtotal);
        linesByVendor.set(
          vendorId,
          allWholesale
            ? lines.map((line) => ({ ...line, saleChannel: SaleChannel.WHOLESALE }))
            : lines.map((line) => ({ ...line, saleChannel: SaleChannel.RETAIL })),
        );
      }

      const discountPlan = await this.resolveDiscounts(
        checkoutDto.couponCode,
        cartSubtotal,
        subtotals,
      );

      const created: Order[] = [];

      for (const [vendorId, lines] of linesByVendor) {
        const subtotal = subtotals.get(vendorId) ?? new Prisma.Decimal(0);
        const discountTotal =
          discountPlan.perVendor.get(vendorId) ?? new Prisma.Decimal(0);

        // Shipping is charged per vendor order, from the server-side zone table.
        const vendorItems = groups.get(vendorId) ?? [];
        const shipping = await this.shipping.calculateFee(
          vendorItems.map((item) => ({
            weightGrams: item.product.weightGrams,
            qty: item.qty,
          })),
          address,
        );
        const shippingFee = shipping.fee;

        // grandTotal = subtotal - discountTotal + shippingFee
        const grandTotal = subtotal.minus(discountTotal).plus(shippingFee);
        const saleChannel =
          lines.length > 0 &&
          lines.every((line) => line.saleChannel === SaleChannel.WHOLESALE)
            ? SaleChannel.WHOLESALE
            : SaleChannel.RETAIL;

        for (const line of lines) {
          const updated = await tx.productVariant.updateMany({
            where: { id: line.productVariantId, stock: { gte: line.qty } },
            data: { stock: { decrement: line.qty } },
          });

          if (updated.count === 0) {
            throw new BadRequestException(
              `Insufficient stock for "${line.productNameSnap}"`,
            );
          }

          touchedVariantIds.add(line.productVariantId);
        }

        const order = await tx.order.create({
          data: {
            orderGroupId,
            orderNumber: await this.generateOrderNumber(tx, datePart),
            buyerId: userId,
            vendorId,
            saleChannel,
            status: OrderStatus.PENDING,
            subtotal,
            discountTotal,
            shippingFee,
            grandTotal,
            couponId: discountTotal.gt(0) ? discountPlan.couponId : null,
            shippingAddress,
            // Start the payment clock. Cleared to null if the buyer picks COD,
            // which is not time-bound.
            expiresAt: new Date(
              Date.now() + this.paymentTtlMinutes() * 60_000,
            ),
            items: {
              create: lines.map((line) => ({
                productVariantId: line.productVariantId,
                productNameSnap: line.productNameSnap,
                qty: line.qty,
                unitPrice: line.unitPrice,
                lineTotal: line.lineTotal,
              })),
            },
            statusHistory: {
              create: {
                fromStatus: null,
                toStatus: OrderStatus.PENDING,
                note: 'Order placed',
                changedById: userId,
              },
            },
          },
          include: { items: true, statusHistory: true },
        });

        created.push(order);
      }

      if (discountPlan.couponId) {
        await this.coupons.incrementUsage(tx, discountPlan.couponId);
      }

      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      this.logger.log(
        `Checkout ${orderGroupId} created ${created.length} order(s) for user ${userId}`,
      );

      return { created, touchedVariantIds: [...touchedVariantIds] };
    }).then(async ({ created, touchedVariantIds }) => {
      // Low-stock alerting runs after the transaction commits, never inside it:
      // it sends email and push over the network, and a failed notification must
      // not roll back a paid order. Stock has already been decremented, so the
      // check sees the true post-purchase level.
      if (touchedVariantIds.length > 0) {
        try {
          const variants = await this.prisma.productVariant.findMany({
            where: { id: { in: touchedVariantIds } },
            select: {
              id: true,
              sku: true,
              stock: true,
              lowStockAlertAt: true,
              product: { select: { id: true, name: true, vendorId: true } },
            },
          });

          await this.lowStock.checkAfterStockChange(variants);
        } catch (error) {
          this.logger.warn(
            `Low-stock check failed for checkout ${orderGroupId}: ${(error as Error).message}`,
          );
        }
      }

      return created;
    });
  }

  private async resolveDiscounts(
    couponCode: string | undefined,
    cartSubtotal: Prisma.Decimal,
    subtotals: Map<string, Prisma.Decimal>,
  ): Promise<DiscountPlan> {
    if (!couponCode) {
      return { perVendor: new Map<string, Prisma.Decimal>(), couponId: null };
    }

    const result = await this.coupons.validateForSubtotal(
      couponCode,
      cartSubtotal,
      subtotals,
    );

    const distribution = new Map<string, Prisma.Decimal>();

    if (result.coupon.vendorId) {
      const vendorId = result.coupon.vendorId;
      const eligible = subtotals.get(vendorId) ?? new Prisma.Decimal(0);
      const capped = result.discountAmount.gt(eligible)
        ? eligible
        : result.discountAmount;
      distribution.set(vendorId, capped);
    } else {
      this.distributeProportionally(
        result.discountAmount,
        subtotals,
        distribution,
      );
    }

    return { perVendor: distribution, couponId: result.coupon.id };
  }

  private distributeProportionally(
    total: Prisma.Decimal,
    weights: Map<string, Prisma.Decimal>,
    target: Map<string, Prisma.Decimal>,
  ) {
    const weightSum = [...weights.values()].reduce(
      (sum, value) => sum.add(value),
      new Prisma.Decimal(0),
    );

    if (weightSum.lte(0)) {
      return;
    }

    let allocated = new Prisma.Decimal(0);
    const entries = [...weights.entries()];
    const lastIndex = entries.length - 1;

    entries.forEach(([vendorId, subtotal], index) => {
      if (index === lastIndex) {
        target.set(vendorId, total.minus(allocated));
        return;
      }

      const share = total.mul(subtotal).div(weightSum);
      target.set(vendorId, share);
      allocated = allocated.add(share);
    });
  }

  private resolveSaleChannel(item: CartItemWithProduct): SaleChannel {
    if (item.product.saleType === SaleType.WHOLESALE) {
      return SaleChannel.WHOLESALE;
    }

    if (
      item.product.saleType === SaleType.BOTH &&
      item.product.minOrderQty &&
      item.qty >= item.product.minOrderQty
    ) {
      return SaleChannel.WHOLESALE;
    }

    return SaleChannel.RETAIL;
  }

  private orderNumberDatePart(): string {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  }

  private async generateOrderNumber(
    tx: Prisma.TransactionClient,
    datePart: string,
  ): Promise<string> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const suffix = randomBytes(3).toString('hex').toUpperCase();
      const orderNumber = `KB-${datePart}-${suffix}`;

      const existing = await tx.order.findUnique({
        where: { orderNumber },
        select: { id: true },
      });

      if (!existing) {
        return orderNumber;
      }
    }
  }
}
