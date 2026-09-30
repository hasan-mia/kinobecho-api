import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Locale } from '@prisma/client';

export class BrandTranslationDto {
  @ApiProperty({ enum: [Locale.bn] })
  @IsEnum(Locale)
  locale: Locale;

  @ApiProperty({ example: 'স্যামসাং' })
  @IsString()
  @Length(1, 120)
  name: string;
}

export class CreateBrandDto {
  @ApiProperty({ example: 'Samsung' })
  @IsString()
  @Length(2, 120)
  name: string;

  @ApiPropertyOptional({ example: 'samsung', description: 'Derived from name if omitted' })
  @IsOptional()
  @IsString()
  @Length(2, 140)
  slug?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/samsung.webp' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @Length(0, 500)
  logoUrl?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ type: [BrandTranslationDto] })
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => BrandTranslationDto)
  @IsOptional()
  translations?: BrandTranslationDto[];
}

export class UpdateBrandDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 140)
  slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  @Length(0, 500)
  logoUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ type: [BrandTranslationDto], description: 'Replaces all translations' })
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => BrandTranslationDto)
  @IsOptional()
  translations?: BrandTranslationDto[];
}

export class ListBrandsQueryDto {
  @ApiPropertyOptional({ description: 'Include inactive brands (admin listing)' })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  includeInactive?: boolean;
}
