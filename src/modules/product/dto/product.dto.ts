import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ProductStatus, SaleType } from '@prisma/client';

export class CreateProductVariantDto {
  @ApiProperty({ example: 'KB-TV-55-4K' })
  @IsString()
  @MinLength(2)
  sku: string;

  @ApiProperty({ example: { size: '55-inch', color: 'Black' } })
  @IsObject()
  attributes: Record<string, string | number | boolean>;

  @ApiProperty({ example: 25 })
  @IsInt()
  @Min(0)
  stock: number;

  @ApiPropertyOptional({ example: 74999.0 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @IsOptional()
  priceOverride?: number;

  @ApiPropertyOptional({ default: 5 })
  @IsInt()
  @Min(0)
  @IsOptional()
  lowStockAlertAt?: number;
}

export class CreatePriceTierDto {
  @ApiProperty({ example: 10 })
  @IsInt()
  @Min(1)
  minQty: number;

  @ApiPropertyOptional({ example: 49 })
  @IsInt()
  @Min(1)
  @IsOptional()
  maxQty?: number;

  @ApiProperty({ example: 70000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  unitPrice: number;
}

export class CreateProductDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  categoryId: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Optional brand' })
  @IsUUID()
  @IsOptional()
  brandId?: string;

  @ApiProperty({ example: 'Sony Bravia 55" 4K Smart TV' })
  @IsString()
  @MinLength(2)
  name: string;

  @ApiPropertyOptional({ example: 'sony-bravia-55-4k-smart-tv' })
  @IsString()
  @IsOptional()
  slug?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ enum: SaleType, default: SaleType.RETAIL })
  @IsEnum(SaleType)
  @IsOptional()
  saleType?: SaleType;

  @ApiPropertyOptional({ enum: ProductStatus, default: ProductStatus.DRAFT })
  @IsEnum(ProductStatus)
  @IsOptional()
  status?: ProductStatus;

  @ApiProperty({ example: 79999.0 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  price: number;

  @ApiPropertyOptional({ example: 5, description: 'Minimum order quantity' })
  @IsInt()
  @Min(1)
  @IsOptional()
  minOrderQty?: number;

  @ApiPropertyOptional({ example: 'Japan' })
  @IsString()
  @IsOptional()
  countryOfOrigin?: string;

  @ApiPropertyOptional({ type: [CreateProductVariantDto] })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateProductVariantDto)
  @IsOptional()
  variants?: CreateProductVariantDto[];

  @ApiPropertyOptional({ type: [CreatePriceTierDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreatePriceTierDto)
  @IsOptional()
  priceTiers?: CreatePriceTierDto[];
}

export class UpdateProductDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  categoryId?: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsUUID()
  @IsOptional()
  brandId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  slug?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ enum: SaleType })
  @IsEnum(SaleType)
  @IsOptional()
  saleType?: SaleType;

  @ApiPropertyOptional({ enum: ProductStatus })
  @IsEnum(ProductStatus)
  @IsOptional()
  status?: ProductStatus;

  @ApiPropertyOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @IsOptional()
  price?: number;

  @ApiPropertyOptional()
  @IsInt()
  @Min(1)
  @IsOptional()
  minOrderQty?: number;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  countryOfOrigin?: string;
}

export class UpdateVariantDto {
  @ApiPropertyOptional({ example: 30 })
  @IsInt()
  @Min(0)
  @IsOptional()
  stock?: number;

  @ApiPropertyOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @IsOptional()
  priceOverride?: number;

  @ApiPropertyOptional()
  @IsInt()
  @Min(0)
  @IsOptional()
  lowStockAlertAt?: number;

  @ApiPropertyOptional()
  @IsObject()
  @IsOptional()
  attributes?: Record<string, string | number | boolean>;
}

export class ListProductsQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit = 20;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  categoryId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  brandId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  vendorId?: string;

  @ApiPropertyOptional({ enum: SaleType })
  @IsEnum(SaleType)
  @IsOptional()
  saleType?: SaleType;

  @ApiPropertyOptional({ enum: ProductStatus })
  @IsEnum(ProductStatus)
  @IsOptional()
  status?: ProductStatus;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({ example: 'price', enum: ['price', 'createdAt', 'name'] })
  @IsString()
  @IsOptional()
  sortBy?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsString()
  @IsOptional()
  order?: 'asc' | 'desc';

  @ApiPropertyOptional({ example: 1000 })
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  minPrice?: number;

  @ApiPropertyOptional({ example: 100000 })
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  maxPrice?: number;
}
