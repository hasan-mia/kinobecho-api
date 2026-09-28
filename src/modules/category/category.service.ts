import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { slugify } from '../../common/utils/slug.util';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';

const TREE_CACHE_KEY = 'category:tree';
const TREE_CACHE_TTL = 300;

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  sortOrder: number;
  isActive: boolean;
  parentId: string | null;
  children: CategoryNode[];
}

@Injectable()
export class CategoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: RedisCacheService,
  ) {}

  async create(dto: CreateCategoryDto) {
    if (dto.parentId) {
      const parent = await this.prisma.category.findUnique({
        where: { id: dto.parentId },
      });

      if (!parent) {
        throw new NotFoundException('Parent category not found');
      }
    }

    const slug = await this.generateUniqueSlug(dto.slug ?? dto.name);

    const category = await this.prisma.category.create({
      data: {
        name: dto.name,
        slug,
        imageUrl: dto.imageUrl,
        sortOrder: dto.sortOrder ?? 0,
        isActive: dto.isActive ?? true,
        parentId: dto.parentId,
      },
    });

    await this.invalidateCache();

    return category;
  }

  async update(id: string, dto: UpdateCategoryDto) {
    const category = await this.prisma.category.findUnique({ where: { id } });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    if (dto.parentId) {
      if (dto.parentId === id) {
        throw new BadRequestException('A category cannot be its own parent');
      }

      const parent = await this.prisma.category.findUnique({
        where: { id: dto.parentId },
      });

      if (!parent) {
        throw new NotFoundException('Parent category not found');
      }

      const isDescendant = await this.isDescendant(dto.parentId, id);
      if (isDescendant) {
        throw new BadRequestException(
          'Cannot move a category under one of its own descendants',
        );
      }
    }

    const slug =
      dto.slug !== undefined
        ? await this.generateUniqueSlug(dto.slug, id)
        : undefined;

    const updated = await this.prisma.category.update({
      where: { id },
      data: {
        name: dto.name,
        slug,
        imageUrl: dto.imageUrl,
        sortOrder: dto.sortOrder,
        isActive: dto.isActive,
        parentId: dto.parentId,
      },
    });

    await this.invalidateCache();

    return updated;
  }

  async remove(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: {
        _count: {
          select: { children: true, products: true },
        },
      },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    if (category._count.children > 0) {
      throw new BadRequestException(
        'Cannot delete a category that has child categories',
      );
    }

    if (category._count.products > 0) {
      throw new BadRequestException(
        'Cannot delete a category that still has products',
      );
    }

    await this.prisma.category.delete({ where: { id } });

    await this.invalidateCache();

    return { message: 'Category deleted' };
  }

  async getTree(includeInactive = false): Promise<CategoryNode[]> {
    const cached = await this.cache.get<CategoryNode[]>(TREE_CACHE_KEY);
    if (cached) {
      return cached;
    }

    const categories = await this.prisma.category.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        imageUrl: true,
        sortOrder: true,
        isActive: true,
        parentId: true,
      },
    });

    const tree = this.buildTree(categories);

    await this.cache.set(TREE_CACHE_KEY, tree, TREE_CACHE_TTL);

    return tree;
  }

  async findBySlug(slug: string) {
    const category = await this.prisma.category.findUnique({
      where: { slug },
      include: {
        parent: {
          select: { id: true, name: true, slug: true },
        },
        children: {
          where: { isActive: true },
          orderBy: { sortOrder: 'asc' },
          select: { id: true, name: true, slug: true, imageUrl: true },
        },
        _count: {
          select: { products: true },
        },
      },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    return category;
  }

  async findAllActive() {
    return this.prisma.category.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        imageUrl: true,
        sortOrder: true,
        parentId: true,
      },
    });
  }

  private buildTree(
    categories: Array<Omit<CategoryNode, 'children'>>,
  ): CategoryNode[] {
    const nodes = new Map<string, CategoryNode>();

    for (const category of categories) {
      nodes.set(category.id, { ...category, children: [] });
    }

    const roots: CategoryNode[] = [];

    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined;

      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  private async isDescendant(
    candidateId: string,
    categoryId: string,
  ): Promise<boolean> {
    let currentId: string | null = candidateId;

    while (currentId) {
      if (currentId === categoryId) {
        return true;
      }

      const node: { parentId: string | null } | null =
        await this.prisma.category.findUnique({
          where: { id: currentId },
          select: { parentId: true },
        });

      currentId = node?.parentId ?? null;
    }

    return false;
  }

  private async invalidateCache() {
    await this.cache.del(TREE_CACHE_KEY);
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
      const existing = await this.prisma.category.findUnique({
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
