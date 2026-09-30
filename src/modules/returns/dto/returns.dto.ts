import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReturnReason } from '@prisma/client';

export class CreateReturnItemDto {
  @ApiProperty({ description: 'OrderItem being returned' })
  @IsString()
  orderItemId: string;

  @ApiProperty({ example: 1, minimum: 1 })
  @IsInt()
  @Min(1)
  qty: number;
}

export class CreateReturnDto {
  @ApiProperty({ example: 'order-uuid' })
  @IsString()
  orderId: string;

  @ApiProperty({ enum: ReturnReason, example: ReturnReason.DAMAGED })
  @IsEnum(ReturnReason)
  reason: ReturnReason;

  @ApiPropertyOptional({ example: 'Arrived with a cracked screen.' })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  comment?: string;

  @ApiPropertyOptional({ type: [String], description: 'Photo URLs as evidence' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Max(10, { each: true })
  evidenceUrls?: string[];

  @ApiProperty({ type: [CreateReturnItemDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => CreateReturnItemDto)
  items: CreateReturnItemDto[];
}

export class ReturnDecisionDto {
  @ApiProperty({ enum: ['APPROVED', 'REJECTED'] })
  @IsEnum(['APPROVED', 'REJECTED'] as unknown as object)
  decision: 'APPROVED' | 'REJECTED';

  @ApiPropertyOptional({ description: 'Required when rejecting' })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  note?: string;
}

export class ReceiveReturnDto {
  @ApiPropertyOptional({
    default: true,
    description: 'Add the returned quantities back to variant stock',
  })
  @IsOptional()
  @IsBoolean()
  restock?: boolean;
}

export class RefundReturnDto {
  @ApiPropertyOptional({
    default: false,
    description: 'Include the original shipping fee in the refund',
  })
  @IsOptional()
  @IsBoolean()
  includeShipping?: boolean;

  @ApiPropertyOptional({ description: 'Recorded on the refund transaction' })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;
}

export class ListReturnsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  vendorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  buyerId?: string;

  @ApiPropertyOptional({ example: '2026-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31T23:59:59.999Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
