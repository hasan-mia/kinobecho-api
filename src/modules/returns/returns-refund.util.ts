import { Prisma } from '@prisma/client';

const ZERO = () => new Prisma.Decimal(0);

/** Round half-up to 2dp, the storage precision of every money column. */
const money = (value: Prisma.Decimal): Prisma.Decimal =>
  value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** Two dp, non-negative. */
const moneyAtLeastZero = (value: Prisma.Decimal): Prisma.Decimal => {
  const rounded = money(value);
  return rounded.isNegative() ? ZERO() : rounded;
};

export interface ReturnableLine {
  orderItemId: string;
  /** Quantity originally purchased on this line. */
  orderedQty: number;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  /** Quantity requested for return in this ReturnRequest. */
  returnQty: number;
}

export interface RefundMathInput {
  lines: ReturnableLine[];
  orderSubtotal: Prisma.Decimal;
  orderDiscountTotal: Prisma.Decimal;
  orderShippingFee: Prisma.Decimal;
  /** `order.grandTotal` minus refunds already completed. Caps the result. */
  refundableRemaining: Prisma.Decimal;
  includeShipping: boolean;
}

export interface RefundMathResult {
  /** Sum of the returned lines, discount excluded. */
  returnedSubtotal: Prisma.Decimal;
  /** The order discount allocated to the returned lines, at full precision. */
  discountShare: Prisma.Decimal;
  /** Rounded amount the buyer is actually refunded. */
  refundAmount: Prisma.Decimal;
  shippingIncluded: Prisma.Decimal;
  /** True when the cap below reduced the result. */
  capped: boolean;
}

/**
 * Works out what a return is worth.
 *
 * Two rules make the arithmetic non-obvious, and both exist to stop a buyer from
 * being refunded more than they paid:
 *
 * 1. **A line refunds proportionally, not at face value.** `lineTotal` is the
 *    whole line, so a 1-of-3 return refunds a third of it. Using `unitPrice *
 *    qty` would drift from `lineTotal` whenever a line's stored total was
 *    rounded, and the drift accumulates across items.
 *
 * 2. **The discount is refunded proportionally too.** A 20% coupon on a 1000
 *    order must not leave the buyer paying 200 of discount on a full return. The
 *    share is computed against the *subtotal*, and shipping is only added when
 *    the caller asks for it — returning goods does not automatically entitle the
 *    buyer to keep the delivery fee on a partial return.
 *
 * The result is finally capped at what the order has left to refund. A second
 * return on the same order must never be able to pay out more than was charged,
 * and that guarantee belongs in the arithmetic rather than in the caller's hope
 * that its own totals happened to line up.
 *
 * Kept free of Prisma calls so the money rules can be asserted directly.
 */
export function computeRefund(input: RefundMathInput): RefundMathResult {
  const returnedSubtotal = input.lines.reduce((sum, line) => {
    if (line.orderedQty <= 0) {
      return sum;
    }
    // Prorate off lineTotal rather than unitPrice so the return can never
    // exceed what was actually charged for the line.
    const share = new Prisma.Decimal(line.lineTotal)
      .mul(line.returnQty)
      .div(line.orderedQty);
    return sum.add(share);
  }, ZERO());

  const returnedSubtotalRounded = money(returnedSubtotal);

  // Undiscounted orders (the common case) short-circuit: dividing by a zero
  // subtotal would produce NaN and poison the whole result.
  const discountShare =
    input.orderSubtotal.gt(0)
      ? new Prisma.Decimal(input.orderDiscountTotal)
          .mul(returnedSubtotal)
          .div(input.orderSubtotal)
      : ZERO();

  const shippingIncluded = input.includeShipping
    ? moneyAtLeastZero(input.orderShippingFee)
    : ZERO();

  const uncapped = money(
    returnedSubtotalRounded.sub(money(discountShare)).add(shippingIncluded),
  );

  const capped = moneyAtLeastZero(uncapped).gt(input.refundableRemaining)
    ? moneyAtLeastZero(input.refundableRemaining)
    : moneyAtLeastZero(uncapped);

  return {
    returnedSubtotal: returnedSubtotalRounded,
    discountShare,
    refundAmount: capped,
    shippingIncluded,
    capped: moneyAtLeastZero(uncapped).gt(input.refundableRemaining),
  };
}

/**
 * Quantity of `orderItemId` still returnable.
 *
 * Anything the buyer has already asked for and not had rejected consumes the
 * allowance: a REQUESTED and an APPROVED request both hold their quantity, and
 * only REJECTED (or CLOSED-without-refund) frees it again. REJECTED is the only
 * terminal-for-purpose state that returns stock to the pool — a closed return was
 * refunded, so its items are gone for good.
 */
export function remainingReturnableQty(
  orderedQty: number,
  alreadyRequested: number,
): number {
  return Math.max(0, orderedQty - alreadyRequested);
}
