import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { SaleType } from '@prisma/client';
import { LocaleQueryDto } from '../../../common/dto/locale-query.dto';

export enum SearchSort {
  RELEVANCE = 'relevance',
  PRICE_ASC = 'price_asc',
  PRICE_DESC = 'price_desc',
  NEWEST = 'newest',
  POPULAR = 'popular',
  RATING = 'rating',
}

export class SearchProductsQueryDto extends LocaleQueryDto {
  @ApiPropertyOptional({ description: 'Free-text query; empty returns the facet set' })
  @IsOptional()
  @IsString()
  @Length(0, 200)
  q?: string;

  @ApiPropertyOptional({ description: 'Matches the category or any ancestor' })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  brandId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vendorId?: string;

  @ApiPropertyOptional({ enum: SaleType })
  @IsOptional()
  @IsEnum(SaleType)
  saleType?: SaleType;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({ description: 'Minimum average rating, 0-5' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(5)
  minRating?: number;

  @ApiPropertyOptional({ enum: SearchSort, default: SearchSort.RELEVANCE })
  @IsOptional()
  @IsEnum(SearchSort)
  sort?: SearchSort;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class SuggestQueryDto extends LocaleQueryDto {
  @ApiPropertyOptional({ minLength: 2 })
  @IsString()
  @Length(2, 100)
  q!: string;
}

export const SUGGEST_LIMIT = 8;
export const SUGGEST_TTL_SECONDS = 60;

export const SORTS_BY_VALUE: Record<
  SearchSort,
  string[] | undefined
> = {
  // No `sort` at all: Meilisearch's own relevance ranking applies, which a sort
  // clause would override.
  [SearchSort.RELEVANCE]: undefined,
  [SearchSort.PRICE_ASC]: ['price:asc'],
  [SearchSort.PRICE_DESC]: ['price:desc'],
  [SearchSort.NEWEST]: ['createdAt:desc'],
  [SearchSort.POPULAR]: ['soldCount:desc'],
  [SearchSort.RATING]: ['ratingAvg:desc'],
};
