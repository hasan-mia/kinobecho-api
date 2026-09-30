import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma, TransactionStatus, TransactionType } from '@prisma/client';
import { CommissionService } from '../src/modules/payouts/commission.service';

describe('CommissionService', () => {
  let service: CommissionService;

  beforeEach(() => {
    service = new CommissionService();
  });

  it('excludes shipping from the commission base', () => {
    // subtotal 1000, discount 100 -> base 900. Shipping is not part of the
    // input at all, which is the point: the courier collects it, not the vendor.
    const result = service.calculate({
      subtotal: new Prisma.Decimal('1000.00'),
      discountTotal: new Prisma.Decimal('100.00'),
      commissionRate: new Prisma.Decimal('10.00'),
    });

    expect(result.commissionAmount.toFixed(2)).toBe('90.00');
    expect(result.vendorEarning.toFixed(2)).toBe('810.00');
  });

  it('makes commission and vendor earning sum to the base', () => {
    const result = service.calculate({
      subtotal: new Prisma.Decimal('1999.99'),
      discountTotal: new Prisma.Decimal('33.33'),
      commissionRate: new Prisma.Decimal('7.50'),
    });

    const base = new Prisma.Decimal('1999.99').minus('33.33');

    expect(
      result.commissionAmount.plus(result.vendorEarning).toFixed(2),
    ).toBe(base.toFixed(2));
  });

  it('rounds half up to two decimals', () => {
    // 3% of 10.15 = 0.3045 -> 0.30
    const a = service.calculate({
      subtotal: new Prisma.Decimal('10.15'),
      discountTotal: new Prisma.Decimal(0),
      commissionRate: new Prisma.Decimal('3.00'),
    });
    expect(a.commissionAmount.toFixed(2)).toBe('0.30');

    // 7.5% of 4.02 = 0.3015 -> 0.30
    const b = service.calculate({
      subtotal: new Prisma.Decimal('4.02'),
      discountTotal: new Prisma.Decimal(0),
      commissionRate: new Prisma.Decimal('7.50'),
    });
    expect(b.commissionAmount.toFixed(2)).toBe('0.30');
  });

  it('rounds an exact half away from zero, not to even', () => {
    // 50% of 0.05 = 0.025, an exact tie. Banker's rounding would give 0.02;
    // half-up must give 0.03 so the platform is never shorted.
    const result = service.calculate({
      subtotal: new Prisma.Decimal('0.05'),
      discountTotal: new Prisma.Decimal(0),
      commissionRate: new Prisma.Decimal('50.00'),
    });

    expect(result.commissionAmount.toFixed(2)).toBe('0.03');
  });

  it('rounds half up on the second tie case', () => {
    // 25% of 0.06 = 0.015 -> 0.02
    const result = service.calculate({
      subtotal: new Prisma.Decimal('0.06'),
      discountTotal: new Prisma.Decimal(0),
      commissionRate: new Prisma.Decimal('25.00'),
    });

    expect(result.commissionAmount.toFixed(2)).toBe('0.02');
  });

  it('handles a zero rate', () => {
    const result = service.calculate({
      subtotal: new Prisma.Decimal('500.00'),
      discountTotal: new Prisma.Decimal(0),
      commissionRate: new Prisma.Decimal(0),
    });

    expect(result.commissionAmount.toFixed(2)).toBe('0.00');
    expect(result.vendorEarning.toFixed(2)).toBe('500.00');
  });

  it('handles a 100% rate', () => {
    const result = service.calculate({
      subtotal: new Prisma.Decimal('500.00'),
      discountTotal: new Prisma.Decimal(0),
      commissionRate: new Prisma.Decimal('100.00'),
    });

    expect(result.commissionAmount.toFixed(2)).toBe('500.00');
    expect(result.vendorEarning.toFixed(2)).toBe('0.00');
  });

  it('handles a full discount', () => {
    const result = service.calculate({
      subtotal: new Prisma.Decimal('500.00'),
      discountTotal: new Prisma.Decimal('500.00'),
      commissionRate: new Prisma.Decimal('10.00'),
    });

    expect(result.commissionAmount.toFixed(2)).toBe('0.00');
    expect(result.vendorEarning.toFixed(2)).toBe('0.00');
  });

  it('avoids a floating-point drift on repeated thirds', () => {
    const result = service.calculate({
      subtotal: new Prisma.Decimal('100.00'),
      discountTotal: new Prisma.Decimal('0.01'),
      commissionRate: new Prisma.Decimal('33.33'),
    });

    // Decimal arithmetic, not float: 33.3299... must not appear anywhere.
    expect(result.commissionAmount.toFixed(2)).toBe('33.33');
    expect(result.vendorEarning.toFixed(2)).toBe('66.66');
  });
});
