import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { addDays } from 'date-fns';
import {
  Prisma,
  QuotationStatus,
  RfqStatus,
  VendorStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { CreateQuotationDto, CreateRfqDto, ListRfqQueryDto } from './dto/rfq.dto';
import { OrderSplitterService } from '../orders/order-splitter.service';
import { ChatService } from '../chat/chat.service';
import { NotificationService } from '../notification/notification.service';

@Injectable()
export class RfqService {
  private readonly logger = new Logger(RfqService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly orders: OrderSplitterService,
    private readonly chat: ChatService,
    private readonly notifications: NotificationService,
  ) {}

  /** Configured window, so the default lifetime of a request is not hardcoded. */
  private defaultWindowDays(): number {
    return this.configService.get<number>('rfq.defaultWindowDays') ?? 7;
  }

  async create(user: AuthenticatedUser, dto: CreateRfqDto) {
    const now = new Date();

    // Either a concrete variant or a category sourcing brief. Allowing neither
    // would queue a request no vendor can meaningfully answer, and allowing both
    // leaves the category filter and the product filter disagreeing.
    if (dto.productId && !dto.productVariantId) {
      // Checked before the generic "no target" case below, so the caller is told
      // the specific thing that is wrong rather than a message they have to
      // re-read their own request to understand.
      throw new BadRequestException(
        'A product must be quoted for as a specific variant, not a product',
      );
    }

    const hasTarget = Boolean(dto.productVariantId || dto.categoryId);
    if (!hasTarget) {
      throw new BadRequestException(
        'Provide either a product variant to be quoted for, or a category',
      );
    }

    if (dto.productVariantId && dto.categoryId) {
      throw new BadRequestException(
        'Provide a product variant or a category, not both',
      );
    }

    if (dto.neededBy && new Date(dto.neededBy) <= now) {
      throw new BadRequestException('neededBy must be in the future');
    }

    const expiresAt = dto.expiresAt
      ? new Date(dto.expiresAt)
      : addDays(now, this.defaultWindowDays());

    if (expiresAt <= now) {
      throw new BadRequestException('expiresAt must be in the future');
    }

    if (dto.productVariantId) {
      // The variant must exist and be sellable. Validated here rather than
      // trusted, because a request pointing at a deleted or draft SKU would be
      // quoted against a product nobody can buy.
      const variant = await this.prisma.productVariant.findFirst({
        where: { id: dto.productVariantId, product: { deletedAt: null } },
        select: { id: true, productId: true, product: { select: { status: true } } },
      });

      if (!variant) {
        throw new NotFoundException('Product variant not found');
      }

      if (variant.product.status !== 'ACTIVE') {
        throw new BadRequestException('That product is not available to order');
      }

      if (dto.productId && dto.productId !== variant.productId) {
        throw new BadRequestException(
          'productId does not match the given variant',
        );
      }
    }

    if (dto.categoryId) {
      const category = await this.prisma.category.findFirst({
        where: { id: dto.categoryId, isActive: true },
        select: { id: true },
      });

      if (!category) {
        throw new NotFoundException('Category not found');
      }
    }

    return this.prisma.rfq.create({
      data: {
        buyerId: user.id,
        productId: dto.productId ?? null,
        productVariantId: dto.productVariantId ?? null,
        categoryId: dto.categoryId ?? null,
        title: dto.title,
        description: dto.description,
        quantity: dto.quantity,
        targetUnitPrice: dto.targetUnitPrice ?? null,
        deliveryDistrict: dto.deliveryDistrict,
        neededBy: dto.neededBy ? new Date(dto.neededBy) : null,
        expiresAt,
        status: RfqStatus.OPEN,
      },
      include: this.rfqInclude,
    });
  }

  /** The buyer's own requests, newest first. */
  async listOwn(user: AuthenticatedUser, query: ListRfqQueryDto) {
    const where: Prisma.RfqWhereInput = {
      buyerId: user.id,
      ...(query.status ? { status: query.status as RfqStatus } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.rfq.findMany({
        where,
        include: { ...this.rfqInclude, quotations: { select: this.buyerQuotationView } },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.rfq.count({ where }),
    ]);

    return this.paginate(items, total, query);
  }

  /**
   * The open pool a vendor may answer.
   *
   * Matching is by category, and a vendor qualifies on any category they
   * actually sell in — including a descendant of the requested one, so a
   * request for "Electronics" still reaches a vendor stocked only in
   * "Headphones". Other vendors' quotations are never included: a buyer learns
   * what is on offer, a competitor does not.
   */
  async listOpenForVendor(user: AuthenticatedUser, query: ListRfqQueryDto) {
    const vendor = await this.requireVendor(user);

    const categoryIds = await this.sellableCategoryIds(vendor.id);

    if (categoryIds.length === 0) {
      return this.paginate([], 0, query);
    }

    const where: Prisma.RfqWhereInput = {
      status: { in: [RfqStatus.OPEN, RfqStatus.QUOTED] },
      expiresAt: { gt: new Date() },
      buyerId: { not: user.id },
      // A request aimed at a specific product belongs to that product's vendor.
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      OR: [
        { categoryId: { in: categoryIds } },
        { product: { categoryId: { in: categoryIds } } },
      ],
    };

    const [items, total] = await Promise.all([
      this.prisma.rfq.findMany({
        where,
        include: {
          ...this.rfqInclude,
          // Which of these the vendor has already answered decides whether they
          // may answer again, and whether the request reads as QUOTED to them.
          quotations: {
            where: { vendorId: vendor.id },
            select: { id: true, status: true, unitPrice: true, validUntil: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.prisma.rfq.count({ where }),
    ]);

    return this.paginate(items, total, query);
  }

  /** A vendor records one offer against a request. */
  async createQuotation(
    user: AuthenticatedUser,
    rfqId: string,
    dto: CreateQuotationDto,
  ) {
    const vendor = await this.requireVendor(user);
    const rfq = await this.prisma.rfq.findUnique({ where: { id: rfqId } });

    if (!rfq) {
      throw new NotFoundException('Request for quotation not found');
    }

    if (rfq.buyerId === vendor.userId) {
      throw new ForbiddenException('You cannot quote on your own request');
    }

    if (rfq.status !== RfqStatus.OPEN && rfq.status !== RfqStatus.QUOTED) {
      throw new BadRequestException(
        `This request is ${rfq.status.toLowerCase()} and no longer accepts quotations`,
      );
    }

    if (rfq.expiresAt <= new Date()) {
      throw new BadRequestException('This request has expired');
    }

    if (dto.minQty > rfq.quantity) {
      throw new BadRequestException(
        `Minimum quantity ${dto.minQty} exceeds the requested ${rfq.quantity}`,
      );
    }

    // A vendor may not quote on a request for their own catalogue item that the
    // buyer has already named: that is a retail sale with extra steps, and the
    // negotiated price would undercut the listed one.
    if (rfq.productVariantId) {
      const variant = await this.prisma.productVariant.findUnique({
        where: { id: rfq.productVariantId },
        select: { product: { select: { vendorId: true } } },
      });

      if (variant?.product.vendorId === vendor.id) {
        throw new ForbiddenException(
          'You cannot send a quotation for a request naming your own product',
        );
      }
    }

    // Default to the request own window so an offer can never outlive it.
    const validUntil = dto.validUntil
      ? new Date(dto.validUntil)
      : rfq.expiresAt;

    if (validUntil <= new Date()) {
      throw new BadRequestException('validUntil must be in the future');
    }

    const existing = await this.prisma.quotation.findUnique({
      where: { rfqId_vendorId: { rfqId, vendorId: vendor.id } },
      select: { id: true },
    });

    if (existing) {
      // Refused rather than overwritten: a silent update would let a vendor
      // lower a price after the buyer has seen it, and would make the "one
      // quotation per vendor" rule depend on a read-then-write race.
      throw new ConflictException('You have already quoted on this request');
    }

    let quotation;
    try {
      quotation = await this.prisma.quotation.create({
        data: {
          rfqId,
          vendorId: vendor.id,
          unitPrice: dto.unitPrice,
          minQty: dto.minQty,
          leadTimeDays: dto.leadTimeDays,
          note: dto.note ?? null,
          validUntil,
          status: QuotationStatus.SENT,
        },
      });
    } catch (error) {
      // The unique index is the real guard; the check above is only there to
      // return a useful message. Two simultaneous quotes land here.
      if (isUniqueViolation(error)) {
        throw new ConflictException('You have already quoted on this request');
      }
      throw error;
    }

    // First answer moves the request out of the unanswered pool. Guarded so a
    // second vendor quoting concurrently does not drag an ACCEPTED request back
    // to QUOTED.
    await this.prisma.rfq.updateMany({
      where: { id: rfqId, status: RfqStatus.OPEN },
      data: { status: RfqStatus.QUOTED },
    });

    this.notifySafely(async () => {
      const results = await Promise.allSettled([
        this.notifications.sendTransactionalEmail(
          user.id,
          user.email ?? '',
          'You received a quotation',
          'rfq-quotation-received',
          { rfqTitle: rfq.title, vendorName: vendor.businessName },
        ),
        this.notifications.sendPushToUser(
          user.id,
          'New quotation received',
          `"${vendor.businessName}" quoted on your request "${rfq.title}"`,
          { rfqId },
        ),
      ]);

      void results;
    });

    return quotation;
  }

  /**
   * Accepts a quotation and turns it into a wholesale order.
   *
   * The whole decision is one transaction. Accepting a quotation writes four
   * things that must agree with each other — the winner, the losers, the
   * request's own status, and the order — and a partial commit would leave a
   * vendor's stock sold at a price only one of two competing quotations had.
   */
  async acceptQuotation(user: AuthenticatedUser, quotationId: string) {
    const found = await this.prisma.quotation.findUnique({
      where: { id: quotationId },
      include: { rfq: true },
    });

    if (!found) {
      throw new NotFoundException('Quotation not found');
    }

    if (found.rfq.buyerId !== user.id) {
      throw new ForbiddenException('Only the requester can accept a quotation');
    }

    if (found.status !== QuotationStatus.SENT) {
      throw new BadRequestException(
        `This quotation is already ${found.status.toLowerCase()}`,
      );
    }

    if (found.validUntil <= new Date()) {
      throw new BadRequestException('This quotation has expired');
    }

    if (found.rfq.status !== RfqStatus.OPEN && found.rfq.status !== RfqStatus.QUOTED) {
      throw new BadRequestException(
        `This request is ${found.rfq.status.toLowerCase()}`,
      );
    }

    // An order line is required to name a concrete variant, so a category-level
    // sourcing brief cannot become an order. Refused before any write, leaving
    // the request and every quotation exactly as they were.
    if (!found.rfq.productVariantId) {
      throw new BadRequestException(
        'This request is for a category, so a quotation cannot become an order. Close the request instead.',
      );
    }

    const variant = await this.prisma.productVariant.findFirst({
      where: { id: found.rfq.productVariantId, product: { deletedAt: null } },
      select: {
        id: true,
        sku: true,
        stock: true,
        product: { select: { id: true, name: true, weightGrams: true } },
      },
    });

    if (!variant) {
      throw new BadRequestException('The quoted product is no longer available');
    }

    const shippingAddress = await this.buildShippingAddress(user, found.rfq.deliveryDistrict);
    const buyerId = user.id;

    const result = await this.prisma.$transaction(async (tx) => {
      // Re-read the quotation under the transaction and only move it if it is
      // still SENT. This conditional update is what actually prevents two
      // concurrent accepts of the same quotation from both succeeding.
      const claimed = await tx.quotation.updateMany({
        where: { id: quotationId, status: QuotationStatus.SENT },
        data: { status: QuotationStatus.ACCEPTED },
      });

      if (claimed.count === 0) {
        throw new ConflictException('This quotation is no longer available');
      }

      await tx.quotation.updateMany({
        where: { rfqId: found.rfqId, id: { not: quotationId }, status: QuotationStatus.SENT },
        data: { status: QuotationStatus.REJECTED },
      });

      await tx.rfq.updateMany({
        where: { id: found.rfqId, status: { in: [RfqStatus.OPEN, RfqStatus.QUOTED] } },
        data: { status: RfqStatus.ACCEPTED },
      });

      const order = await this.orders.createWholesaleOrderFromQuotation(tx, {
        rfq: {
          id: found.rfq.id,
          buyerId: found.rfq.buyerId,
          title: found.rfq.title,
          quantity: found.rfq.quantity,
          deliveryDistrict: found.rfq.deliveryDistrict,
        },
        quotation: {
          id: found.id,
          vendorId: found.vendorId,
          unitPrice: found.unitPrice,
          minQty: found.minQty,
          leadTimeDays: found.leadTimeDays,
        },
        variant,
        shippingAddress,
      });

      return order;
    });

    this.notifySafely(() =>
      this.notifyVendor(
        found.vendorId,
        'rfq-quotation-accepted',
        {
          rfqTitle: found.rfq.title,
          orderNumber: result.orderNumber,
        },
        { rfqId: found.rfqId, quotationId },
      ),
    );

    return { order: result, quotationId };
  }

  /** Opens, or reuses, the buyer–vendor chat thread behind a quotation. */
  async openChat(user: AuthenticatedUser, quotationId: string) {
    const quotation = await this.prisma.quotation.findUnique({
      where: { id: quotationId },
      select: { rfq: { select: { buyerId: true } }, vendorId: true },
    });

    if (!quotation) {
      throw new NotFoundException('Quotation not found');
    }

    if (quotation.rfq.buyerId !== user.id) {
      throw new ForbiddenException(
        'Only the requester can open chat from a quotation',
      );
    }

    return this.chat.createOrFindThread(user, quotation.vendorId);
  }

  /**
   * Notifies the user behind a vendor record, on both channels.
   *
   * A quotation is a conversation between two people, so the recipient is a
   * vendor account's owner rather than the vendor row itself. Email is skipped
   * when the user has no address on file — a push-only recipient is normal for
   * this codebase and must not be treated as an error.
   */
  private async notifyVendor(
    vendorId: string,
    templateKey: string,
    payload: Record<string, string>,
    data: Record<string, string>,
  ): Promise<void> {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { userId: true, user: { select: { email: true } } },
    });

    if (!vendor) {
      return;
    }

    const results = await Promise.allSettled([
      vendor.user.email
        ? this.notifications.sendTransactionalEmail(
            vendor.userId,
            vendor.user.email,
            'Your quotation was accepted',
            templateKey,
            payload,
          )
        : Promise.resolve(),
      this.notifications.sendPushToUser(
        vendor.userId,
        'Quotation accepted',
        `Your quotation for "${payload.rfqTitle ?? ''}" was accepted`,
        data,
      ),
    ]);

    void results;
  }

  /**
   * Builds the order's shipping snapshot.
   *
   * An order needs a shipping address, and a request only carries a delivery
   * district. The buyer's default address is used when there is one; otherwise
   * the district alone is recorded, which is what the courier leg will need
   * before the vendor confirms contact details at order fulfilment.
   */
  private async buildShippingAddress(
    user: AuthenticatedUser,
    deliveryDistrict: string,
  ): Promise<Prisma.InputJsonValue> {
    const address = await this.prisma.address.findFirst({
      where: { userId: user.id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });

    if (address) {
      return {
        recipientName: address.recipientName,
        phone: address.phone,
        line1: address.line1,
        line2: address.line2,
        city: address.city,
        district: address.district ?? deliveryDistrict,
        postalCode: address.postalCode,
        country: address.country,
        label: address.label,
        // Provenance, so a reader can tell a quoted district from a real address.
        fromRfqDistrict: address.district === deliveryDistrict,
      } as Prisma.InputJsonValue;
    }

    return {
      recipientName: user.name,
      phone: null,
      line1: null,
      line2: null,
      city: null,
      district: deliveryDistrict,
      postalCode: null,
      country: 'BD',
      label: 'RFQ delivery district',
      fromRfqDistrict: true,
    };
  }

  private async requireVendor(user: AuthenticatedUser) {
    const vendor = await this.prisma.vendor.findFirst({
      where: { userId: user.id, deletedAt: null },
      select: { id: true, userId: true, businessName: true, status: true },
    });

    if (!vendor) {
      throw new ForbiddenException('Only vendors can do this');
    }

    if (vendor.status !== VendorStatus.ACTIVE) {
      throw new ForbiddenException('Your vendor account is not active');
    }

    return vendor;
  }

  /**
   * Every category id a vendor may answer for: the categories their live
   * products sit in, plus all descendants of those.
   *
   * Descendants matter because requests are frequently filed against a parent
   * category, and a vendor stocked only in a subcategory is exactly who should
   * see it.
   */
  private async sellableCategoryIds(vendorId: string): Promise<string[]> {
    const products = await this.prisma.product.findMany({
      where: { vendorId, deletedAt: null, status: 'ACTIVE' },
      select: { categoryId: true },
      distinct: ['categoryId'],
    });

    const direct = [...new Set(products.map((p) => p.categoryId).filter(Boolean))] as string[];

    if (direct.length === 0) {
      return [];
    }

    const all = await this.prisma.category.findMany({
      select: { id: true, parentId: true },
    });

    const result = new Set(direct);

    for (const root of direct) {
      // Breadth-first over the parentId map. A cycle in category data would
      // otherwise loop forever, hence the visited set.
      const queue = [root];
      const visited = new Set<string>([root]);

      while (queue.length > 0) {
        const current = queue.shift() as string;
        result.add(current);

        for (const child of all.filter((c) => c.parentId === current)) {
          if (!visited.has(child.id)) {
            visited.add(child.id);
            queue.push(child.id);
          }
        }
      }
    }

    return [...result];
  }

  /**
   * Runs a notification without letting it fail the request.
   *
   * Notifications go over the network to FCM/SMS/email; a buyer's quotation has
   * already been accepted by the time one of them is attempted, and failing the
   * accepted order because a push provider was down would be the wrong trade.
   */
  private notifySafely(send: () => Promise<unknown>): void {
    void Promise.resolve()
      .then(send)
      .catch((error: Error) => {
        this.logger.warn(`RFQ notification failed: ${error.message}`);
      });
  }

  private readonly rfqInclude = {
    product: { select: { id: true, name: true, slug: true } },
    productVariant: { select: { id: true, sku: true } },
    category: { select: { id: true, name: true, slug: true } },
  } satisfies Prisma.RfqInclude;

  /** What a buyer may see of a vendor offer: the numbers, not who else bid. */
  private readonly buyerQuotationView = {
    id: true,
    unitPrice: true,
    minQty: true,
    leadTimeDays: true,
    note: true,
    validUntil: true,
    status: true,
    createdAt: true,
    vendor: { select: { id: true, businessName: true, slug: true } },
  } satisfies Prisma.QuotationSelect;

  private paginate<T>(items: T[], total: number, query: ListRfqQueryDto) {
    return {
      items,
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }
}

/** Prisma's code for a unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}
