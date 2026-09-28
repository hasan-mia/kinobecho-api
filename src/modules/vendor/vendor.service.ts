import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole, VendorStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import {
  ApplyVendorDto,
  ListVendorsQueryDto,
  SuspendVendorDto,
  UpdateVendorDto,
} from './dto/vendor.dto';

const VENDOR_CACHE_PREFIX = 'vendor:public:';

@Injectable()
export class VendorService {
  private readonly logger = new Logger(VendorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: RedisCacheService,
  ) {}

  async apply(user: AuthenticatedUser, dto: ApplyVendorDto) {
    const existing = await this.prisma.vendor.findUnique({
      where: { userId: user.id },
    });

    if (existing) {
      throw new ConflictException('You have already applied as a vendor');
    }

    const slug = await this.generateUniqueSlug(dto.businessName);

    const vendor = await this.prisma.$transaction(async (tx) => {
      const created = await tx.vendor.create({
        data: {
          userId: user.id,
          businessName: dto.businessName,
          slug,
          description: dto.description,
          logoUrl: dto.logoUrl,
          bannerUrl: dto.bannerUrl,
          payoutMethod: dto.payoutMethod,
          payoutAccountInfo: dto.payoutAccountInfo as Prisma.InputJsonValue,
          status: VendorStatus.PENDING,
          kycStatus: 'PENDING',
        },
      });

      await tx.user.update({
        where: { id: user.id },
        data: { role: UserRole.VENDOR },
      });

      return created;
    });

    return vendor;
  }

  async getMyVendor(user: AuthenticatedUser) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { userId: user.id },
      include: {
        _count: {
          select: { products: true, orders: true },
        },
      },
    });

    if (!vendor) {
      throw new NotFoundException('Vendor profile not found');
    }

    return vendor;
  }

  async updateMyVendor(user: AuthenticatedUser, dto: UpdateVendorDto) {
    const vendor = await this.getMyVendor(user);

    const updated = await this.prisma.vendor.update({
      where: { id: vendor.id },
      data: {
        businessName: dto.businessName,
        description: dto.description,
        logoUrl: dto.logoUrl,
        bannerUrl: dto.bannerUrl,
        payoutMethod: dto.payoutMethod,
        payoutAccountInfo: dto.payoutAccountInfo as
          | Prisma.InputJsonValue
          | undefined,
      },
    });

    await this.invalidatePublicCache(updated.slug);

    return updated;
  }

  async getPublicBySlug(slug: string) {
    const cacheKey = `${VENDOR_CACHE_PREFIX}${slug}`;
    const cached = await this.cache.get<Record<string, unknown>>(cacheKey);
    if (cached) {
      return cached;
    }

    const vendor = await this.prisma.vendor.findFirst({
      where: { slug, status: VendorStatus.ACTIVE, deletedAt: null },
      select: {
        id: true,
        businessName: true,
        slug: true,
        logoUrl: true,
        bannerUrl: true,
        description: true,
        createdAt: true,
        _count: {
          select: {
            products: { where: { status: 'ACTIVE', deletedAt: null } },
          },
        },
      },
    });

    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }

    await this.cache.set(cacheKey, vendor, 300);

    return vendor;
  }

  async findAll(query: ListVendorsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.VendorWhereInput = {
      deletedAt: null,
      status: query.status,
      kycStatus: query.kycStatus,
    };

    if (query.search) {
      where.OR = [
        { businessName: { contains: query.search, mode: 'insensitive' } },
        { slug: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.vendor.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: { id: true, email: true, name: true, phone: true },
          },
        },
      }),
      this.prisma.vendor.count({ where }),
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

  async findOne(id: string) {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id },
      include: {
        user: {
          select: { id: true, email: true, name: true, phone: true },
        },
      },
    });

    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }

    return vendor;
  }

  async approve(id: string) {
    const vendor = await this.prisma.vendor.findUnique({ where: { id } });

    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }

    if (vendor.status === VendorStatus.ACTIVE) {
      throw new BadRequestException('Vendor is already active');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.vendor.update({
        where: { id },
        data: {
          status: VendorStatus.ACTIVE,
          kycStatus: 'APPROVED',
        },
      });

      await tx.user.update({
        where: { id: vendor.userId },
        data: { role: UserRole.VENDOR },
      });

      return result;
    });

    await this.invalidatePublicCache(updated.slug);

    return updated;
  }

  async suspend(id: string, dto: SuspendVendorDto) {
    const vendor = await this.prisma.vendor.findUnique({ where: { id } });

    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }

    if (vendor.status === VendorStatus.SUSPENDED) {
      throw new BadRequestException('Vendor is already suspended');
    }

    const updated = await this.prisma.vendor.update({
      where: { id },
      data: {
        status: VendorStatus.SUSPENDED,
        description: dto.reason
          ? `${vendor.description ?? ''}\n[Suspended] ${dto.reason}`.trim()
          : vendor.description,
      },
    });

    await this.invalidatePublicCache(updated.slug);

    return updated;
  }

  async reactivate(id: string) {
    const vendor = await this.findOne(id);

    const updated = await this.prisma.vendor.update({
      where: { id: vendor.id },
      data: { status: VendorStatus.ACTIVE },
    });

    await this.invalidatePublicCache(updated.slug);

    return updated;
  }

  private async invalidatePublicCache(slug: string) {
    await this.cache.del(`${VENDOR_CACHE_PREFIX}${slug}`);
  }

  private async generateUniqueSlug(businessName: string): Promise<string> {
    const base =
      businessName
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 50) || 'vendor';

    let slug = base;
    let counter = 1;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const existing = await this.prisma.vendor.findUnique({
        where: { slug },
        select: { id: true },
      });

      if (!existing) {
        return slug;
      }

      counter += 1;
      slug = `${base}-${counter}`;
    }
  }
}
