import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { BannerLinkType, BannerPlacement, HomeSectionType } from '@prisma/client';

export class CreateBannerDto {
  @ApiProperty({ example: 'Eid collection' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title: string;

  @ApiProperty({ example: 'https://cdn.kinobecho.com/banners/eid.webp' })
  @IsString()
  imageUrl: string;

  @ApiPropertyOptional({ example: 'https://cdn.kinobecho.com/banners/eid-sm.webp' })
  @IsString()
  @IsOptional()
  mobileImageUrl?: string;

  @ApiPropertyOptional({ enum: BannerLinkType, default: BannerLinkType.NONE })
  @IsEnum(BannerLinkType)
  @IsOptional()
  linkType?: BannerLinkType;

  @ApiPropertyOptional({ description: 'Product/category/vendor id, or absolute URL for linkType URL' })
  @IsString()
  @IsOptional()
  linkValue?: string;

  @ApiProperty({ enum: BannerPlacement })
  @IsEnum(BannerPlacement)
  placement: BannerPlacement;

  @ApiPropertyOptional({ default: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsDateString()
  @IsOptional()
  startsAt?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsDateString()
  @IsOptional()
  endsAt?: string;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateBannerDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @IsOptional()
  title?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  imageUrl?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  mobileImageUrl?: string;

  @ApiPropertyOptional({ enum: BannerLinkType })
  @IsEnum(BannerLinkType)
  @IsOptional()
  linkType?: BannerLinkType;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  linkValue?: string;

  @ApiPropertyOptional({ enum: BannerPlacement })
  @IsEnum(BannerPlacement)
  @IsOptional()
  placement?: BannerPlacement;

  @ApiPropertyOptional()
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsDateString()
  @IsOptional()
  startsAt?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsDateString()
  @IsOptional()
  endsAt?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class CreateSectionDto {
  @ApiProperty({ example: 'Best sellers' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title: string;

  @ApiProperty({ enum: HomeSectionType })
  @IsEnum(HomeSectionType)
  type: HomeSectionType;

  @ApiProperty({
    example: { productIds: ['8f2c...'] },
    description:
      'PRODUCT_LIST/FLASH_SALE: { productIds }. CATEGORY_LIST: { categoryIds }. BANNER: { bannerIds }. FLASH_SALE may add { endsAt }.',
  })
  @IsObject()
  config: Record<string, unknown>;

  @ApiPropertyOptional({ default: 0 })
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateSectionDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ enum: HomeSectionType })
  @IsEnum(HomeSectionType)
  @IsOptional()
  type?: HomeSectionType;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  config?: Record<string, unknown>;

  @ApiPropertyOptional()
  @IsInt()
  @Min(0)
  @IsOptional()
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

/**
 * A reorder request is a full ordering rather than a single `sortOrder` patch:
 * the client already knows the complete list it saw, so sending indices once
 * beats N round trips and makes the result independent of arrival order.
 */
export class ReorderDto {
  @ApiProperty({
    type: [String],
    description: 'Entity ids in their intended display order',
  })
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  items: string[];
}

export class ListBannersQueryDto {
  @ApiPropertyOptional({ enum: BannerPlacement })
  @IsEnum(BannerPlacement)
  @IsOptional()
  placement?: BannerPlacement;

  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page = 1;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit = 50;
}

export class UploadBannerImageDto {
  @ApiPropertyOptional({
    enum: ['imageUrl', 'mobileImageUrl'],
    default: 'imageUrl',
    description: 'Which banner field the uploaded creative fills.',
  })
  @IsEnum(['imageUrl', 'mobileImageUrl'])
  @IsOptional()
  target: 'imageUrl' | 'mobileImageUrl' = 'imageUrl';
}

export class ListSectionsQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page = 1;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit = 50;
}

export class BannerIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id: string;
}

export class SectionIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id: string;
}
