import { Injectable } from '@nestjs/common';
import { Product, ProductVariant } from '@prisma/client';
import { NotificationService } from '../notification/notification.service';
import { PrismaService } from '../../database/prisma.service';

/**
 * Warns a vendor when one of their variants falls to or below its alert level.
 *
 * Deduplicated by `ProductVariant.lowStockNotifiedAt`: the flag is set on the
 * first warning and cleared once stock recovers, so a product that hovers on the
 * threshold across many checkouts produces one email, not one per sale. Reusing
 * a `updateMany` with a `lowStockNotifiedAt: null` predicate makes the claim
 * atomic, so two concurrent checkouts cannot both send.
 */
@Injectable()
export class LowStockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * @param variants  Variants touched by a stock change, with the post-change
   *                  stock level already applied.
   */
  async checkAfterStockChange(
    variants: (Pick<ProductVariant, 'id' | 'stock' | 'lowStockAlertAt' | 'sku'> & {
      product: Pick<Product, 'id' | 'name' | 'vendorId'>;
    })[],
  ): Promise<void> {
    for (const variant of variants) {
      if (variant.stock <= variant.lowStockAlertAt) {
        await this.notifyOnce(variant);
      } else {
        await this.reset(variant.id);
      }
    }
  }

  private async notifyOnce(
    variant: Pick<ProductVariant, 'id' | 'stock' | 'lowStockAlertAt' | 'sku'> & {
      product: Pick<Product, 'id' | 'name' | 'vendorId'>;
    },
  ): Promise<void> {
    // The `lowStockNotifiedAt: null` predicate is the deduplication guard: only
    // the call that flips it from null sends the notification.
    const claimed = await this.prisma.productVariant.updateMany({
      where: { id: variant.id, lowStockNotifiedAt: null },
      data: { lowStockNotifiedAt: new Date() },
    });

    if (claimed.count === 0) {
      return;
    }

    const vendor = await this.prisma.vendor.findUnique({
      where: { id: variant.product.vendorId },
      select: { id: true, businessName: true, userId: true },
    });

    if (!vendor?.userId) {
      return;
    }

    const title = 'Low stock alert';
    const body =
      `${variant.product.name} (${variant.sku}) is down to ${variant.stock} ` +
      `unit(s), at or below your alert level of ${variant.lowStockAlertAt}.`;

    // Email and push are independent: a missing FCM credential must not stop
    // the email, and vice versa.
    const results = await Promise.allSettled([
      this.notifications.sendTransactionalEmail(
        vendor.userId,
        await this.vendorEmail(vendor.userId),
        title,
        'low-stock-alert',
        {
          name: vendor.businessName,
          productName: variant.product.name,
          sku: variant.sku,
          stock: String(variant.stock),
          threshold: String(variant.lowStockAlertAt),
          productUrl: '',
        },
      ),
      this.notifications.sendPushToUser(vendor.userId, title, body, {
        productId: variant.product.id,
        variantId: variant.id,
      }),
    ]);

    // AllSettled is deliberate: a missing FCM credential must not stop the
    // email. NotificationService already logs each failure.
    void results;
  }

  private async vendorEmail(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });

    return user?.email ?? '';
  }

  /** Clears the flag once stock is healthy again, re-arming the alert. */
  private async reset(variantId: string): Promise<void> {
    await this.prisma.productVariant.updateMany({
      where: { id: variantId, lowStockNotifiedAt: { not: null } },
      data: { lowStockNotifiedAt: null },
    });
  }
}
