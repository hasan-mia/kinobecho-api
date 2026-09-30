import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  ProductStatus,
  SaleType,
  UserRole,
  VendorStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { slugify } from '../../common/utils/slug.util';
import { ProductPricingService } from './pricing/product-pricing.service';
import { SearchSyncService } from '../search/search-sync.service';
import {
  CreateProductDto,
  ListProductsQueryDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/product.dto';

const SORTABLE_FIELDS: Record<string, Prisma.ProductOrderByWithRelationInput> = {
  price: { price: 'asc' },
  createdAt: { createdAt: 'asc' },
  name: { name: 'asc' },
};

@Injectable()
export class ProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: ProductPricingService,
    private readonly search: SearchSyncService,
  ) {}

  async create(user: AuthenticatedUser, dto: CreateProductDto) {
    const vendor = await this.requireActiveVendor(user);

    const category = await this.prisma.category.findUnique({
      where: { id: dto.categoryId },
    });

    if (!category || !category.isActive) {
      throw new NotFoundException('Category not found or inactive');
    }

    const slug = await this.generateUniqueSlug(dto.slug ?? dto.name);

    const created = await this.prisma.product.create({
      data: {
        brandId: dto.brandId,
        vendorId: vendor.id,
        categoryId: dto.categoryId,
        name: dto.name,
        slug,
        description: dto.description,
        saleType: dto.saleType ?? SaleType.RETAIL,
        status: dto.status ?? ProductStatus.DRAFT,
        price: new Prisma.Decimal(dto.price),
        minOrderQty: dto.minOrderQty,
        countryOfOrigin: dto.countryOfOrigin,
        variants: dto.variants?.length
          ? {
              create: dto.variants.map((variant) => ({
                sku: variant.sku,
                attributes: variant.attributes as Prisma.InputJsonValue,
                stock: variant.stock,
                priceOverride:
                  variant.priceOverride !== undefined
                    ? new Prisma.Decimal(variant.priceOverride)
                    : null,
                lowStockAlertAt: variant.lowStockAlertAt ?? 5,
              })),
            }
          : undefined,
        priceTiers: dto.priceTiers?.length
          ? {
              create: dto.priceTiers.map((tier) => ({
                minQty: tier.minQty,
                maxQty: tier.maxQty ?? null,
                unitPrice: new Prisma.Decimal(tier.unitPrice),
              })),
            }
          : undefined,
      },
      include: {
        variants: true,
        priceTiers: { orderBy: { minQty: 'asc' } },
      },
    });

    await this.search.enqueueUpsert(created.id);

    return created;
  }

  async findAll(query: ListProductsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      status: query.status ?? ProductStatus.ACTIVE,
      categoryId: query.categoryId,
      brandId: query.brandId,
      vendorId: query.vendorId,
      saleType: query.saleType,
    };

    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }

    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      where.price = {};
      if (query.minPrice !== undefined) {
        where.price.gte = new Prisma.Decimal(query.minPrice);
      }
      if (query.maxPrice !== undefined) {
        where.price.lte = new Prisma.Decimal(query.maxPrice);
      }
    }

    const sortField = SORTABLE_FIELDS[query.sortBy ?? 'createdAt'];
    const direction = query.order ?? 'desc';

    const orderBy: Prisma.ProductOrderByWithRelationInput = sortField
      ? (Object.fromEntries(
          Object.entries(sortField).map(([key, value]) => [
            key,
            direction === 'asc' ? value : invertDirection(value),
          ]),
        ) as Prisma.ProductOrderByWithRelationInput)
      : { createdAt: direction === 'asc' ? 'asc' : 'desc' };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy,
        include: {
          images: {
            where: { isPrimary: true },
            take: 1,
          },
          vendor: {
            select: { id: true, businessName: true, slug: true, logoUrl: true },
          },
          category: { select: { id: true, name: true, slug: true } },
          brand: { select: { id: true, name: true, slug: true, logoUrl: true } },
          _count: { select: { variants: true } },
        },
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findBySlug(slug: string) {
    const product = await this.prisma.product.findFirst({
      where: { slug, deletedAt: null },
      include: {
        variants: { orderBy: { createdAt: 'asc' } },
        priceTiers: { orderBy: { minQty: 'asc' } },
        images: { orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }] },
        vendor: {
          select: {
            id: true,
            businessName: true,
            slug: true,
            logoUrl: true,
            status: true,
            createdAt: true,
          },
        },
        category: { select: { id: true, name: true, slug: true } },
        brand: { select: { id: true, name: true, slug: true, logoUrl: true } },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  async findOne(id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
      include: {
        variants: true,
        priceTiers: { orderBy: { minQty: 'asc' } },
        images: true,
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  async update(user: AuthenticatedUser, id: string, dto: UpdateProductDto) {
    const product = await this.assertCanManage(user, id);

    if (dto.categoryId) {
      const category = await this.prisma.category.findUnique({
        where: { id: dto.categoryId },
      });

      if (!category || !category.isActive) {
        throw new NotFoundException('Category not found or inactive');
      }
    }

    const slug =
      dto.slug !== undefined
        ? await this.generateUniqueSlug(dto.slug, id)
        : dto.name !== undefined
          ? await this.generateUniqueSlug(dto.name, id)
          : undefined;

    const updated = await this.prisma.product.update({
      where: { id: product.id },
      data: {
        brandId: dto.brandId,
        categoryId: dto.categoryId,
        name: dto.name,
        slug,
        description: dto.description,
        saleType: dto.saleType,
        status: dto.status,
        price:
          dto.price !== undefined ? new Prisma.Decimal(dto.price) : undefined,
        minOrderQty: dto.minOrderQty,
        countryOfOrigin: dto.countryOfOrigin,
      },
    });

    await this.search.enqueueUpsert(updated.id);

    return updated;
  }

  async updateVariant(
    user: AuthenticatedUser,
    productId: string,
    variantId: string,
    dto: UpdateVariantDto,
  ) {
    const product = await this.assertCanManage(user, productId);

    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
    });

    if (!variant || variant.productId !== product.id) {
      throw new NotFoundException('Variant not found');
    }

    const updated = await this.prisma.productVariant.update({
      where: { id: variant.id },
      data: {
        stock: dto.stock,
        priceOverride:
          dto.priceOverride !== undefined
            ? new Prisma.Decimal(dto.priceOverride)
            : undefined,
        lowStockAlertAt: dto.lowStockAlertAt,
        attributes: dto.attributes as Prisma.InputJsonValue | undefined,
      },
    });

    // Attributes and price overrides are both on the search document.
    await this.search.enqueueUpsert(product.id);

    return updated;
  }

  async remove(user: AuthenticatedUser, id: string) {
    const product = await this.assertCanManage(user, id);

    await this.prisma.product.update({
      where: { id: product.id },
      data: { deletedAt: new Date(), status: ProductStatus.ARCHIVED },
    });

    // An archived product must leave the index, not be filtered out of it: a
    // missed status change would otherwise keep it in results forever.
    await this.search.enqueueDelete(product.id);

    return { message: 'Product deleted' };
  }

  async resolvePrice(productId: string, qty: number) {
    return this.pricing.resolveUnitPrice(productId, qty);
  }

  private async requireActiveVendor(user: AuthenticatedUser) {
    if (!user.vendor) {
      throw new ForbiddenException('Only vendors can perform this action');
    }

    const vendor = await this.prisma.vendor.findUnique({
      where: { id: user.vendor.id },
    });

    if (!vendor) {
      throw new ForbiddenException('Vendor profile not found');
    }

    if (vendor.status !== VendorStatus.ACTIVE) {
      throw new ForbiddenException(
        'Vendor account is not active yet. Complete KYC approval first.',
      );
    }

    return vendor;
  }

  private async assertCanManage(user: AuthenticatedUser, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const isAdmin =
      user.role === UserRole.ADMIN || user.role === UserRole.SUPER_ADMIN;

    if (isAdmin) {
      return product;
    }

    if (!user.vendor || product.vendorId !== user.vendor.id) {
      throw new ForbiddenException('You can only manage your own products');
    }

    await this.requireActiveVendor(user);

    return product;
  }

  private async generateUniqueSlug(
    name: string,
    excludeId?: string,
  ): Promise<string> {
    const base = slugify(name);

    if (!base) {
      throw new BadRequestException('Cannot derive a slug from the given name');
    }

    let slug = base;
    let counter = 1;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const existing = await this.prisma.product.findUnique({
        where: { slug },
        select: { id: true },
      });

      if (!existing || existing.id === excludeId) {
        return slug;
      }

      counter += 1;
      slug = `${base}-${counter}`;
    }
  }
}

function invertDirection(value: unknown): 'asc' | 'desc' {
  return value === 'asc' ? 'desc' : 'asc';
}
