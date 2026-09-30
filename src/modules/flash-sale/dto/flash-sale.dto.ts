import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { FlashSaleItemStatus } from '@prisma/client';

export class CreateFlashSaleDto {
  @ApiProperty({ example: 'Eid Flash Sale' })
  @IsString()
  @MinLength(2)
  title: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  startsAt: string;

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  endsAt: string;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class UpdateFlashSaleDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(2)
  @IsOptional()
  title?: string;

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

export class NominateItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Omit to discount the product as a whole rather than one variant.',
  })
  @IsUUID()
  @IsOptional()
  variantId?: string;

  @ApiProperty({ example: '199.00' })
  @IsString()
  @MinLength(1)
  salePrice: string;

  @ApiProperty({ example: 100, description: 'Flash-sale unit budget' })
  @IsInt()
  @Min(1)
  stockLimit: number;

  @ApiPropertyOptional({ default: 1, description: 'Units one buyer may buy' })
  @IsInt()
  @Min(1)
  @IsOptional()
  perUserLimit?: number;
}

export class UpdateFlashSaleItemDto {
  @ApiPropertyOptional({ example: '199.00' })
  @IsString()
  @MinLength(1)
  @IsOptional()
  salePrice?: string;

  @ApiPropertyOptional()
  @IsInt()
  @Min(1)
  @IsOptional()
  stockLimit?: number;

  @ApiPropertyOptional()
  @IsInt()
  @Min(1)
  @IsOptional()
  perUserLimit?: number;
}

export class ModerateItemDto {
  @ApiProperty({ enum: [FlashSaleItemStatus.APPROVED, FlashSaleItemStatus.REJECTED] })
  @IsEnum(FlashSaleItemStatus)
  status:
    | typeof FlashSaleItemStatus.APPROVED
    | typeof FlashSaleItemStatus.REJECTED;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  reason?: string;
}

export class ListFlashSalesQueryDto {
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

export class FlashSaleIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id: string;
}

export class FlashSaleItemIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  itemId: string;
}
