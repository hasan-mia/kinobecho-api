import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { OrderStatus } from '@prisma/client';

export class CheckoutDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  addressId: string;

  @ApiPropertyOptional({ example: 'EID2026' })
  @IsString()
  @IsOptional()
  couponCode?: string;
}

export class ListOrdersQueryDto {
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
  orderGroupId?: string;

  @ApiPropertyOptional({ enum: OrderStatus })
  @IsEnum(OrderStatus)
  @IsOptional()
  status?: OrderStatus;
}

export class UpdateOrderStatusDto {
  @ApiProperty({ enum: OrderStatus })
  @IsEnum(OrderStatus)
  status: OrderStatus;

  @ApiPropertyOptional({ example: 'Handed over to courier' })
  @IsString()
  @IsOptional()
  note?: string;
}

export class CancelOrderDto {
  @ApiPropertyOptional({ example: 'Changed my mind' })
  @IsString()
  @MinLength(2)
  @IsOptional()
  reason?: string;
}
