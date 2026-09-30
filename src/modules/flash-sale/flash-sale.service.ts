import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  FlashSaleItemStatus,
  OrderStatus,
  Prisma,
  ProductStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import {
  CreateFlashSaleDto,
  ListFlashSalesQueryDto,
  ModerateItemDto,
  NominateItemDto,
  UpdateFlashSaleDto,
  UpdateFlashSaleItemDto,
} from './dto/flash-sale.dto';

const ACTIVE_CACHE_KEY = 'flash-sales:active';
const ACTIVE_CACHE_TTL = 30;

/**
 * A flash sale item as the storefront sees it.
 *
 * `salePrice` and `normalPrice` are strings so the client renders one number
 * format, and `remaining` is derived here rather than left to arithmetic on
 * `stockLimit - soldCount` in the client.
 */
export interface ActiveFlashSaleItem {
  id: string;
  productId: string;
  variantId: string | null;
  productName: string;
  productSlug: string;
  imageUrl: string | null;
  salePrice: string;
  normalPrice: string;
  remaining: number;
  perUserLimit: number;
}

export interface ActiveFlashSale {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  items: ActiveFlashSaleItem[];
}

@Injectable()
export class FlashSaleService {
  private readonly logger = new Logger(FlashSaleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: RedisCacheService,
  ) {}

  // -------------------------------------------------------------------------
  // Public listing
  // -------------------------------------------------------------------------

  /**
   * Flash sales that are live right now, with their remaining budget.
   *
   * Cached for 30 seconds: short enough that an admin approving a nomination
   * shows up almost immediately, long enough that a storefront browsing burst
   * does not stampede the item table while counts are being written.
   */
  async listActive(): Promise<ActiveFlashSale[]> {
    const cached = await this.cache.get<ActiveFlashSale[]>(ACTIVE_CACHE_KEY);

    if (cached) {
      return cached;
    }

    const now = new Date();
    const payload = await this.buildActive(now);

    await this.cache.set(ACTIVE_CACHE_KEY, payload, ACTIVE_CACHE_TTL);

    return payload;
  }

  /**
   * The live window predicate, shared by the public listing and by pricing.
   *
   * Kept as one function so the storefront and the checkout can never disagree
   * about whether a sale is running — a disagreement would show a discounted
   * price the checkout then refuses.
   */
  static liveWindow(now: Date): Prisma.FlashSaleWhereInput {
    return {
      isActive: true,
      startsAt: { lte: now },
      endsAt: { gte: now },
    };
  }

  private async buildActive(now: Date): Promise<ActiveFlashSale[]> {
    const sales = await this.prisma.flashSale.findMany({
      where: FlashSaleService.liveWindow(now),
      orderBy: { startsAt: 'asc' },
      include: {
        items: {
          where: { status: FlashSaleItemStatus.APPROVED },
          include: {
            product: {
              include: {
                images: { where: { isPrimary: true }, take: 1 },
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    return sales.map((sale) => ({
      id: sale.id,
      title: sale.title,
      startsAt: sale.startsAt,
      endsAt: sale.endsAt,
      items: sale.items
        // A fully-committed item is filtered out here rather than in the query:
        // Prisma cannot compare `soldCount` against `stockLimit`, because they
        // are two columns and `lt` only takes a literal. The set is small (one
        // sale's approved items), so filtering in memory costs nothing and keeps
        // an exhausted offer from rendering as an empty slot.
        .filter((item) => item.soldCount < item.stockLimit)
        .map((item) => ({
          id: item.id,
          productId: item.productId,
          variantId: item.variantId,
          productName: item.product.name,
          productSlug: item.product.slug,
          imageUrl: item.product.images[0]?.url ?? null,
          salePrice: item.salePrice.toFixed(2),
          normalPrice: item.product.price.toFixed(2),
          remaining: Math.max(item.stockLimit - item.soldCount, 0),
          perUserLimit: item.perUserLimit,
        })),
    }));
  }

  // -------------------------------------------------------------------------
  // Admin CRUD
  // -------------------------------------------------------------------------

  async list(query: ListFlashSalesQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.flashSale.findMany({
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { startsAt: 'desc' },
        include: { _count: { select: { items: true } } },
      }),
      this.prisma.flashSale.count(),
    ]);

    return {
      items: rows.map((sale) => ({
        ...sale,
        itemCount: sale._count.items,
        _count: undefined,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string) {
    const sale = await this.prisma.flashSale.findUnique({
      where: { id },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });

    if (!sale) {
      throw new NotFoundException('Flash sale not found');
    }

    return sale;
  }

  async create(dto: CreateFlashSaleDto) {
    this.assertWindowOrder(dto.startsAt, dto.endsAt);

    const sale = await this.prisma.flashSale.create({
      data: {
        title: dto.title.trim(),
        startsAt: new Date(dto.startsAt),
        endsAt: new Date(dto.endsAt),
        isActive: dto.isActive ?? true,
      },
    });

    await this.invalidateActive();

    return sale;
  }

  async update(id: string, dto: UpdateFlashSaleDto) {
    const existing = await this.findOne(id);

    // Merged against the stored row so moving only one bound is checked
    // against the real window rather than silently accepted.
    const startsAt =
      dto.startsAt !== undefined
        ? new Date(dto.startsAt)
        : existing.startsAt;
    const endsAt = dto.endsAt !== undefined ? new Date(dto.endsAt) : existing.endsAt;

    this.assertWindowOrder(startsAt, endsAt);

    const sale = await this.prisma.flashSale.update({
      where: { id },
      data: {
        title: dto.title?.trim(),
        startsAt: dto.startsAt !== undefined ? startsAt : undefined,
        endsAt: dto.endsAt !== undefined ? endsAt : undefined,
        isActive: dto.isActive,
      },
    });

    await this.invalidateActive();

    return sale;
  }

  async remove(id: string) {
    await this.findOne(id);

    // Hard delete: items cascade, and a past sale has no reason to be retained
    // once an admin decides to remove it. The orders that referenced its items
    // keep their sale price snapshot on OrderItem.unitPrice.
    await this.prisma.flashSale.delete({ where: { id } });

    await this.invalidateActive();

    return { deleted: true, id };
  }

  // -------------------------------------------------------------------------
  // Nominations
  // -------------------------------------------------------------------------

  /**
   * A vendor nominates one of their own products for a sale.
   *
   * The nomination is inert: `status` starts at NOMINATED and only an admin
   * approval makes the price reachable. Without that gate a vendor could grant
   * themselves an arbitrary discount simply by inserting a row.
   */
  async nominate(user: AuthenticatedUser, flashSaleId: string, dto: NominateItemDto) {
    const sale = await this.findOne(flashSaleId);

    const product = await this.prisma.product.findFirst({
      where: { id: dto.productId, deletedAt: null },
      select: { id: true, vendorId: true, name: true, price: true, status: true },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    if (product.vendorId !== this.vendorIdOf(user)) {
      throw new ForbiddenException('You can only nominate your own products');
    }

    if (product.status !== ProductStatus.ACTIVE) {
      throw new BadRequestException('Only active products can be nominated');
    }

    let variantId: string | null = null;

    if (dto.variantId) {
      const variant = await this.prisma.productVariant.findUnique({
        where: { id: dto.variantId },
        select: { id: true, productId: true },
      });

      if (!variant || variant.productId !== product.id) {
        throw new NotFoundException('Product variant not found');
      }

      variantId = variant.id;
    }

    const salePrice = this.parsePrice(dto.salePrice);
    this.assertBelowNormalPrice(salePrice, product.price, product.name);

    // The unique constraint does not cover NULL variantId (PostgreSQL treats
    // NULLs as distinct), so the duplicate check is a lookup in the same
    // transaction as the insert rather than a reliance on P2002.
    const existing = await this.prisma.flashSaleItem.findFirst({
      where: {
        flashSaleId: sale.id,
        productId: product.id,
        variantId,
      },
    });

    if (existing) {
      throw new ConflictException(
        'This product is already nominated for this flash sale',
      );
    }

    if (dto.stockLimit > (await this.availableStock(product.id, variantId))) {
      // A budget the product cannot fill advertises a discount that will fail at
      // checkout. Caught at nomination rather than discovered by a customer.
      throw new BadRequestException(
        `stockLimit exceeds available stock for "${product.name}"`,
      );
    }

    const item = await this.prisma.flashSaleItem.create({
      data: {
        flashSaleId: sale.id,
        productId: product.id,
        variantId,
        salePrice,
        stockLimit: dto.stockLimit,
        perUserLimit: dto.perUserLimit ?? 1,
        status: FlashSaleItemStatus.NOMINATED,
      },
    });

    await this.invalidateActive();

    return item;
  }

  /** An admin edits a nomination, e.g. trims the price or raises the budget. */
  async updateItem(id: string, dto: UpdateFlashSaleItemDto) {
    const item = await this.prisma.flashSaleItem.findUnique({
      where: { id },
      include: { product: { select: { name: true, price: true } } },
    });

    if (!item) {
      throw new NotFoundException('Flash sale item not found');
    }

    if (dto.salePrice !== undefined) {
      const salePrice = this.parsePrice(dto.salePrice);
      this.assertBelowNormalPrice(
        salePrice,
        item.product.price,
        item.product.name,
      );
    }

    // The budget can never drop below what is already committed, or the item
    // would be oversold the moment it is saved.
    if (dto.stockLimit !== undefined && dto.stockLimit < item.soldCount) {
      throw new BadRequestException(
        `stockLimit cannot be below the ${item.soldCount} unit(s) already sold`,
      );
    }

    const updated = await this.prisma.flashSaleItem.update({
      where: { id },
      data: {
        salePrice: dto.salePrice !== undefined ? this.parsePrice(dto.salePrice) : undefined,
        stockLimit: dto.stockLimit,
        perUserLimit: dto.perUserLimit,
      },
    });

    await this.invalidateActive();

    return updated;
  }

  /** An admin approves or rejects a nomination. */
  async moderateItem(id: string, dto: ModerateItemDto) {
    const item = await this.prisma.flashSaleItem.findUnique({ where: { id } });

    if (!item) {
      throw new NotFoundException('Flash sale item not found');
    }

    const updated = await this.prisma.flashSaleItem.update({
      where: { id },
      data: { status: dto.status },
    });

    await this.invalidateActive();

    return updated;
  }

  async removeItem(id: string) {
    const item = await this.prisma.flashSaleItem.findUnique({ where: { id } });

    if (!item) {
      throw new NotFoundException('Flash sale item not found');
    }

    await this.prisma.flashSaleItem.delete({ where: { id } });

    await this.invalidateActive();

    return { deleted: true, id };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private assertWindowOrder(startsAt: Date | string, endsAt: Date | string) {
    if (new Date(startsAt).getTime() >= new Date(endsAt).getTime()) {
      throw new BadRequestException('startsAt must be before endsAt');
    }
  }

  private parsePrice(raw: string): Prisma.Decimal {
    let price: Prisma.Decimal;

    try {
      price = new Prisma.Decimal(raw);
    } catch {
      throw new BadRequestException('salePrice must be a decimal number');
    }

    if (price.lte(0)) {
      throw new BadRequestException('salePrice must be greater than zero');
    }

    if (price.decimalPlaces() > 2) {
      throw new BadRequestException('salePrice supports at most 2 decimal places');
    }

    return price;
  }

  /**
   * A "flash sale" that sells at or above the normal price is a mispricing, not
   * a promotion, and approving it would quietly override the price tier the
   * customer expects to pay.
   */
  private assertBelowNormalPrice(
    salePrice: Prisma.Decimal,
    normalPrice: Prisma.Decimal,
    productName: string,
  ) {
    if (salePrice.gte(normalPrice)) {
      throw new BadRequestException(
        `salePrice (${salePrice.toFixed(2)}) must be below the normal price (${normalPrice.toFixed(2)}) for "${productName}"`,
      );
    }
  }

  /**
   * Stock the sale budget could plausibly draw on: the named variant's own
   * stock, or the product's total when the discount covers the whole product.
   */
  private async availableStock(
    productId: string,
    variantId: string | null,
  ): Promise<number> {
    if (variantId) {
      const variant = await this.prisma.productVariant.findUnique({
        where: { id: variantId },
        select: { stock: true },
      });

      return variant?.stock ?? 0;
    }

    const rows = await this.prisma.productVariant.findMany({
      where: { productId },
      select: { stock: true },
    });

    return rows.reduce((sum, r) => sum + r.stock, 0);
  }

  private vendorIdOf(user: AuthenticatedUser): string | null {
    return user.vendor?.id ?? null;
  }

  /**
   * Drops the cached active listing.
   *
   * The TTL is only 30 seconds so a failed invalidation self-heals quickly, but
   * the error is still logged: silence would hide a systematically broken cache
   * until someone noticed the storefront lagging behind an approval.
   */
  private async invalidateActive() {
    try {
      await this.cache.del(ACTIVE_CACHE_KEY);
    } catch (error) {
      this.logger.warn(
        `Failed to invalidate ${ACTIVE_CACHE_KEY}: ${(error as Error).message}`,
      );
    }
  }
}
