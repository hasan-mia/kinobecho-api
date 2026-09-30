import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Locale, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { slugify } from '../../common/utils/slug.util';
import { DEFAULT_LOCALE } from '../../common/i18n/locale.util';
import { applyTranslation } from '../../common/i18n/translation.util';
import { SearchSyncService } from '../search/search-sync.service';
import {
  CreateBrandDto,
  ListBrandsQueryDto,
  UpdateBrandDto,
} from './dto/brand.dto';

@Injectable()
export class BrandService {
  private readonly logger = new Logger(BrandService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchSyncService,
  ) {}

  /**
   * Public listing. Only active brands reach the storefront: an inactive brand
   * is a merchandising decision, not a deletion, and its products stay in the
   * catalogue but must not be offered as a filter choice.
   */
  async list(query: ListBrandsQueryDto, locale: Locale = DEFAULT_LOCALE) {
    const brands = await this.prisma.brand.findMany({
      where: query.includeInactive ? {} : { isActive: true },
      orderBy: { name: 'asc' },
      include: { translations: true },
    });

    // Ordered on the base name so the brand list does not reshuffle when the
    // caller switches locale.
    return brands.map((b) => applyTranslation(b, b.translations, locale));
  }

  async findOne(id: string, locale: Locale = DEFAULT_LOCALE) {
    const brand = await this.prisma.brand.findUnique({
      where: { id },
      include: { translations: true },
    });

    if (!brand) {
      throw new NotFoundException('Brand not found');
    }

    return applyTranslation(brand, brand.translations, locale);
  }

  async create(dto: CreateBrandDto) {
    const slug = await this.uniqueSlug(dto.slug ?? dto.name);

    return this.prisma.brand.create({
      data: {
        name: dto.name.trim(),
        slug,
        logoUrl: dto.logoUrl ?? null,
        isActive: dto.isActive ?? true,
        translations: dto.translations?.length
          ? {
              create: dto.translations.map((t) => ({
                locale: t.locale,
                name: t.name,
              })),
            }
          : undefined,
      },
    });
  }

  async update(id: string, dto: UpdateBrandDto) {
    const brand = await this.findOne(id);

    // Translations replace wholesale so a locale can be removed by omitting it.
    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.translations !== undefined) {
        await tx.brandTranslation.deleteMany({ where: { brandId: id } });
      }

      return tx.brand.update({
        where: { id: brand.id },
        data: {
          name: dto.name?.trim(),
          slug: dto.slug !== undefined ? await this.uniqueSlug(dto.slug, id) : undefined,
          logoUrl: dto.logoUrl,
          isActive: dto.isActive,
          translations: dto.translations?.length
            ? {
                create: dto.translations.map((t) => ({
                  locale: t.locale,
                  name: t.name,
                })),
              }
            : undefined,
        },
      });
    });

    // The brand's name and logo are denormalised onto every product document,
    // so a rename makes the whole catalogue's index stale. Re-queueing each
    // affected product is cheap next to a full rebuild and keeps the latency
    // bounded by the brand's size, not the catalogue's.
    const affected = await this.prisma.product.findMany({
      where: { brandId: id },
      select: { id: true },
    });

    for (const product of affected) {
      await this.search.enqueueUpsert(product.id);
    }

    if (affected.length > 0) {
      this.logger.log(
        `Brand ${id} changed; re-queued ${affected.length} product(s) for indexing`,
      );
    }

    return updated;
  }

  /**
   * Deactivates rather than deletes.
   *
   * Products point at the brand with `onDelete: SetNull`, so a hard delete would
   * silently strip the brand off every product in the catalogue and orphan the
   * storefront's filter values. Deactivating hides it and can be undone.
   */
  async remove(id: string) {
    const brand = await this.findOne(id);

    return this.prisma.brand.update({
      where: { id: brand.id },
      data: { isActive: false },
    });
  }

  private async uniqueSlug(raw: string, excludeId?: string): Promise<string> {
    const base = slugify(raw);

    if (!base) {
      throw new ConflictException('Brand name must contain letters or digits');
    }

    let candidate = base;
    let suffix = 1;

    // Bounded rather than unbounded: a pathological clash should surface as a
    // conflict, not spin.
    for (let attempt = 0; attempt < 50; attempt++) {
      const existing = await this.prisma.brand.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });

      if (!existing || existing.id === excludeId) {
        return candidate;
      }

      candidate = `${base}-${++suffix}`;
    }

    throw new ConflictException('Could not derive a unique brand slug');
  }
}

export type BrandWithCounts = Prisma.BrandGetPayload<{
  include: { _count: { select: { products: true } } };
}>;
