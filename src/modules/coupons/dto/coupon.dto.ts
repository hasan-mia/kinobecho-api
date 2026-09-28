import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { DiscountType } from '@prisma/client';

export class CreateCouponDto {
  @ApiProperty({ example: 'EID2026' })
  @IsString()
  @MinLength(3)
  code: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Omit for a platform-wide coupon',
  })
  @IsUUID()
  @IsOptional()
  vendorId?: string;

  @ApiProperty({ enum: DiscountType })
  @IsEnum(DiscountType)
  discountType: DiscountType;

  @ApiProperty({ example: 10 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  discountValue: number;

  @ApiPropertyOptional({ example: 5000 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  minOrderValue?: number;

  @ApiPropertyOptional({ example: 1000 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  usageLimit?: number;

  @ApiPropertyOptional({ example: '2026-12-31T23:59:59.000Z' })
  @IsDateString()
  @IsOptional()
  expiresAt?: string;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class ListCouponsQueryDto {
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
  vendorId?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class ValidateCouponDto {
  @ApiProperty({ example: 'EID2026' })
  @IsString()
  @MinLength(3)
  code: string;

  @ApiProperty({ example: 25000 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  cartSubtotal: number;
}
