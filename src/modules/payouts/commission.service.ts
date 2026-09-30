import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export interface CommissionBreakdown {
  commissionRate: Prisma.Decimal;
  commissionAmount: Prisma.Decimal;
  vendorEarning: Prisma.Decimal;
}

/**
 * The single definition of how platform commission is calculated.
 *
 * Shared by the delivery snapshot and by the wallet's *estimate*, so the two
 * cannot disagree. Payouts deliberately do not use this — they read the values
 * snapshotted onto the order, which is the whole point of the snapshot.
 */
@Injectable()
export class CommissionService {
  /**
   * Splits an order's merchandise value between the platform and the vendor.
   *
   * The base is `subtotal - discountTotal` and **excludes `shippingFee`**: the
   * buyer pays shipping to the courier, not to the vendor, so charging commission
   * on it would take a cut of money the vendor never receives.
   *
   * Rounded half-up to 2 decimals rather than banker's rounding, so a vendor is
   * never shorted by a floating-point tie (0.005 always rounds away from zero).
   */
  calculate(input: {
    subtotal: Prisma.Decimal;
    discountTotal: Prisma.Decimal;
    commissionRate: Prisma.Decimal;
  }): CommissionBreakdown {
    const base = new Prisma.Decimal(input.subtotal)
      .minus(input.discountTotal)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

    const commissionAmount = base
      .mul(input.commissionRate)
      .div(100)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

    // Derived from the rounded commission so the two always sum back to the base
    // exactly; recomputing the earning independently would drift by a cent.
    const vendorEarning = base.minus(commissionAmount);

    return {
      commissionRate: input.commissionRate,
      commissionAmount,
      vendorEarning,
    };
  }

  /**
   * Commission for an order that has not been delivered yet, using the vendor's
   * *current* rate. This is an estimate shown in the wallet and is labelled as
   * such — it is not what a payout will pay.
   */
  estimateForOrder(
    order: {
      subtotal: Prisma.Decimal;
      discountTotal: Prisma.Decimal;
    },
    currentRate: Prisma.Decimal,
  ): CommissionBreakdown {
    return this.calculate({
      subtotal: order.subtotal,
      discountTotal: order.discountTotal,
      commissionRate: currentRate,
    });
  }
}
