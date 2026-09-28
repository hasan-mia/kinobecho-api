import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Coupon,
  DiscountType,
  Prisma,
  UserRole,
  VendorStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import {
  CreateCouponDto,
  ListCouponsQueryDto,
  ValidateCouponDto,
} from './dto/coupon.dto';

export interface CouponValidationResult {
  coupon: Coupon;
  discountAmount: Prisma.Decimal;
  eligibleSubtotal: Prisma.Decimal;
}

@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(user: AuthenticatedUser, dto: CreateCouponDto) {
    const isAdmin =
      user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN;

    if (!isAdmin) {
      if (!user.vendor) {
        throw new ForbiddenException('Only vendors can create coupons');
      }

      if (dto.vendorId && dto.vendorId !== user.vendor.id) {
        throw new ForbiddenException('You can only create your own coupons');
      }

      const vendor = await this.prisma.vendor.findUnique({
        where: { id: dto.vendorId ?? user.vendor.id },
      });

      if (!vendor || vendor.status !== VendorStatus.ACTIVE) {
        throw new BadRequestException('Vendor is not active');
      }
    }

    const code = dto.code.trim().toUpperCase();
    const existing = await this.prisma.coupon.findUnique({ where: { code } });

    if (existing) {
      throw new BadRequestException('Coupon code already exists');
    }

    return this.prisma.coupon.create({
      data: {
        code,
        vendorId: dto.vendorId ?? null,
        discountType: dto.discountType,
        discountValue: new Prisma.Decimal(dto.discountValue),
        minOrderValue: dto.minOrderValue !== undefined
          ? new Prisma.Decimal(dto.minOrderValue)
          : null,
        usageLimit: dto.usageLimit ?? null,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async findAll(query: ListCouponsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.CouponWhereInput = {
      vendorId: query.vendorId,
      isActive: query.isActive,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.coupon.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          vendor: { select: { id: true, businessName: true, slug: true } },
        },
      }),
      this.prisma.coupon.count({ where }),
    ]);

    return {
      items,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async validate(dto: ValidateCouponDto): Promise<CouponValidationResult> {
    return this.validateForSubtotal(dto.code, new Prisma.Decimal(dto.cartSubtotal));
  }

  /**
   * Validates a coupon against a subtotal without applying it. A vendor-scoped
   * coupon only discounts the portion of the cart that belongs to that vendor.
   */
  async validateForSubtotal(
    code: string,
    cartSubtotal: Prisma.Decimal,
    vendorSubtotalByVendorId?: Map<string, Prisma.Decimal>,
  ): Promise<CouponValidationResult> {
    const coupon = await this.prisma.coupon.findUnique({
      where: { code: code.trim().toUpperCase() },
    });

    if (!coupon) {
      throw new NotFoundException('Coupon not found');
    }

    if (!coupon.isActive) {
      throw new BadRequestException('Coupon is not active');
    }

    if (coupon.expiresAt && coupon.expiresAt < new Date()) {
      throw new BadRequestException('Coupon has expired');
    }

    if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
      throw new BadRequestException('Coupon usage limit reached');
    }

    const eligibleSubtotal = coupon.vendorId
      ? (vendorSubtotalByVendorId?.get(coupon.vendorId) ?? new Prisma.Decimal(0))
      : cartSubtotal;

    if (coupon.minOrderValue && eligibleSubtotal.lt(coupon.minOrderValue)) {
      throw new BadRequestException(
        `Minimum order value for this coupon is ${coupon.minOrderValue}`,
      );
    }

    const discountAmount =
      coupon.discountType === DiscountType.PERCENT
        ? eligibleSubtotal.mul(coupon.discountValue).div(100)
        : coupon.discountValue;

    const capped = discountAmount.gt(eligibleSubtotal)
      ? eligibleSubtotal
      : discountAmount;

    return { coupon, discountAmount: capped, eligibleSubtotal };
  }

  async incrementUsage(
    tx: Prisma.TransactionClient,
    couponId: string,
  ): Promise<void> {
    await tx.coupon.update({
      where: { id: couponId },
      data: { usedCount: { increment: 1 } },
    });
  }
}
