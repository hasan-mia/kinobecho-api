import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  computeRefund,
  remainingReturnableQty,
} from '../src/modules/returns/returns-refund.util';

const dec = (v: string) => new Prisma.Decimal(v);
const line = (
  orderedQty: number,
  lineTotal: string,
  returnQty: number,
  orderItemId = `oi-${orderedQty}-${returnQty}`,
) => ({
  orderItemId,
  orderedQty,
  unitPrice: dec(lineTotal).div(orderedQty),
  lineTotal: dec(lineTotal),
  returnQty,
});

const base = {
  orderSubtotal: dec('1000'),
  orderDiscountTotal: dec('0'),
  orderShippingFee: dec('60'),
  refundableRemaining: dec('1000'),
  includeShipping: false,
};

describe('computeRefund', () => {
  it('refunds a whole line at face value when nothing was discounted', () => {
    const result = computeRefund({ ...base, lines: [line(2, '500', 2)] });

    expect(result.refundAmount.toFixed(2)).toBe('500.00');
    expect(result.discountShare.toFixed(2)).toBe('0.00');
    expect(result.shippingIncluded.toFixed(2)).toBe('0.00');
    expect(result.capped).toBe(false);
  });

  it('prorates a partial line instead of refunding unitPrice * qty', () => {
    const result = computeRefund({ ...base, lines: [line(3, '300', 1)] });

    // One of three units, priced off lineTotal so rounding on the stored total
    // can never push the refund above what was charged.
    expect(result.refundAmount.toFixed(2)).toBe('100.00');
  });

  it('sums several lines', () => {
    const result = computeRefund({
      ...base,
      lines: [line(1, '250', 1, 'a'), line(2, '400', 1, 'b')],
    });

    expect(result.refundAmount.toFixed(2)).toBe('450.00');
  });

  it('refunds the proportional share of the order discount', () => {
    const result = computeRefund({
      ...base,
      orderDiscountTotal: dec('200'),
      lines: [line(1, '1000', 1)],
    });

    // A 20% coupon on a 1000 order cannot leave the buyer paying 200 of it on a
    // full return.
    expect(result.discountShare.toFixed(2)).toBe('200.00');
    expect(result.refundAmount.toFixed(2)).toBe('800.00');
  });

  it('refunds only the discount attributable to the returned lines', () => {
    const result = computeRefund({
      ...base,
      orderDiscountTotal: dec('200'),
      lines: [line(1, '1000', 1, 'half')].map(() => line(1, '500', 1, 'half')),
    });

    expect(result.discountShare.toFixed(2)).toBe('100.00');
    expect(result.refundAmount.toFixed(2)).toBe('400.00');
  });

  it('adds shipping only when asked', () => {
    const without = computeRefund({ ...base, lines: [line(1, '500', 1)] });
    const with_ = computeRefund({
      ...base,
      lines: [line(1, '500', 1)],
      includeShipping: true,
    });

    expect(without.refundAmount.toFixed(2)).toBe('500.00');
    expect(with_.refundAmount.toFixed(2)).toBe('560.00');
    expect(with_.shippingIncluded.toFixed(2)).toBe('60.00');
  });

  it('caps the refund at what the order has left to give back', () => {
    const result = computeRefund({
      ...base,
      lines: [line(1, '1000', 1)],
      refundableRemaining: dec('250'),
    });

    expect(result.refundAmount.toFixed(2)).toBe('250.00');
    expect(result.capped).toBe(true);
  });

  it('never returns a negative amount when a discount exceeds the lines', () => {
    const result = computeRefund({
      ...base,
      orderSubtotal: dec('100'),
      orderDiscountTotal: dec('200'),
      lines: [line(1, '100', 1)],
      includeShipping: false,
    });

    expect(result.refundAmount.toFixed(2)).toBe('0.00');
  });

  it('survives a zero subtotal instead of dividing by zero', () => {
    const result = computeRefund({
      ...base,
      orderSubtotal: dec('0'),
      orderDiscountTotal: dec('0'),
      lines: [line(1, '100', 1)],
    });

    expect(result.refundAmount.toFixed(2)).toBe('100.00');
  });

  it('rounds half-up to the storage precision of the money column', () => {
    const result = computeRefund({
      ...base,
      // 3 x 33.33 = 99.99 stored; one unit is 33.33 exactly.
      lines: [line(3, '99.99', 1)],
    });

    expect(result.refundAmount.toFixed(2)).toBe('33.33');
  });
});

describe('remainingReturnableQty', () => {
  it('is the purchased quantity when nothing is in flight', () => {
    expect(remainingReturnableQty(3, 0)).toBe(3);
  });

  it('subtracts what other live returns already hold', () => {
    expect(remainingReturnableQty(3, 2)).toBe(1);
  });

  it('never goes below zero when returns overlap', () => {
    expect(remainingReturnableQty(2, 5)).toBe(0);
  });
});
