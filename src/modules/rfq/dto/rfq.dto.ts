import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Prisma } from '@prisma/client';

const DECIMAL_12_2 = { decimalPlaces: 2, maxDecimalPlaces: 2 };

/**
 * Creates a request for quotation.
 *
 * Exactly one target is required: either a concrete `productVariantId` or a
 * `categoryId`. Both are optional in the database so a category-level sourcing
 * brief needs no product, but a request with neither is meaningless and is
 * rejected by the service rather than left to sit in the vendor queue forever.
 */
export class CreateRfqDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Category-level sourcing request target' })
  @IsUUID()
  @IsOptional()
  categoryId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Product the request is about' })
  @IsUUID()
  @IsOptional()
  productId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The exact variant being quoted for. Required alongside productId, and the ' +
      'only case in which an accepted quotation can become an order.',
  })
  @IsUUID()
  @IsOptional()
  productVariantId?: string;

  @ApiProperty({ example: '500 units of 5W LED bulb' })
  @IsString()
  @MinLength(4)
  @MaxLength(160)
  title: string;

  @ApiProperty({ example: 'Need at least 30 days of life. Bulk packing preferred.' })
  @IsString()
  @MinLength(10)
  @MaxLength(4000)
  description: string;

  @ApiProperty({ example: 500, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity: number;

  @ApiPropertyOptional({
    example: 120.5,
    description:
      'Indicative budget. Never used to price an order — the accepted quotation is ' +
      'the only price that reaches checkout.',
    ...DECIMAL_12_2,
  })
  @Type(() => Number)
  @IsNumber(DECIMAL_12_2, { message: 'targetUnitPrice must have at most 2 decimal places' })
  @Min(0)
  @IsOptional()
  targetUnitPrice?: Prisma.Decimal;

  @ApiProperty({ example: 'Dhaka' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  deliveryDistrict: string;

  @ApiPropertyOptional({ example: '2026-10-15T00:00:00.000Z' })
  @IsDateString()
  @IsOptional()
  neededBy?: string;

  @ApiPropertyOptional({
    example: '2026-10-07T00:00:00.000Z',
    description: 'Defaults to config-configured window from now.',
  })
  @IsDateString()
  @IsOptional()
  expiresAt?: string;
}

/** A vendor's answer to a request for quotation. */
export class CreateQuotationDto {
  @ApiProperty({ example: 115.75, ...DECIMAL_12_2 })
  @Type(() => Number)
  @IsNumber(DECIMAL_12_2, { message: 'unitPrice must have at most 2 decimal places' })
  @Min(0)
  unitPrice: Prisma.Decimal;

  @ApiProperty({
    example: 100,
    minimum: 1,
    description: 'Smallest quantity the vendor will supply at this price.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minQty: number;

  @ApiProperty({ example: 7, minimum: 0, description: 'Days until the goods can ship.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  leadTimeDays: number;

  @ApiPropertyOptional({ example: 'Price holds for Dhaka delivery only.' })
  @IsString()
  @MaxLength(2000)
  @IsOptional()
  note?: string;

  @ApiPropertyOptional({
    example: '2026-10-05T00:00:00.000Z',
    description: 'Defaults to the RFQ own window, so an offer never outlives its request.',
  })
  @IsDateString()
  @IsOptional()
  validUntil?: string;
}

/** Paging for the buyer own RFQs and the vendor open pool. */
export class ListRfqQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit = 20;

  @ApiPropertyOptional({ description: 'Filter by lifecycle state.' })
  @IsString()
  @Matches(/^(OPEN|QUOTED|ACCEPTED|CLOSED|EXPIRED)$/, {
    message: 'status must be one of OPEN, QUOTED, ACCEPTED, CLOSED, EXPIRED',
  })
  @IsOptional()
  status?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  categoryId?: string;
}
