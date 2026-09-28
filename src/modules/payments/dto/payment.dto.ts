import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { PaymentGateway } from '@prisma/client';

export class CreateOrderPaymentDto {
  @ApiProperty({ enum: PaymentGateway, example: PaymentGateway.BKASH })
  @IsEnum(PaymentGateway)
  gateway: PaymentGateway;
}

export class RefundOrderDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  orderId: string;

  @ApiPropertyOptional({ example: 1500.5 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @IsOptional()
  amount?: number;

  @ApiPropertyOptional({ example: 'Customer requested a partial refund' })
  @IsString()
  @IsOptional()
  note?: string;

  @ApiPropertyOptional({ enum: PaymentGateway })
  @IsEnum(PaymentGateway)
  @IsOptional()
  gateway?: PaymentGateway;
}

export class ListPaymentsQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @Min(1)
  @IsOptional()
  page = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @Type(() => Number)
  @Min(1)
  @Max(100)
  @IsOptional()
  limit = 20;
}
