import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
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
import { OrderStatus, SaleChannel } from '@prisma/client';

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

export class ListAdminOrdersQueryDto {
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

  @ApiPropertyOptional({ enum: OrderStatus, enumName: 'OrderStatus' })
  @IsEnum(OrderStatus)
  @IsOptional()
  status?: OrderStatus;

  @ApiPropertyOptional({ enum: SaleChannel, enumName: 'SaleChannel' })
  @IsEnum(SaleChannel)
  @IsOptional()
  saleChannel?: SaleChannel;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  vendorId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  buyerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsUUID()
  @IsOptional()
  orderGroupId?: string;

  @ApiPropertyOptional({ description: 'Filter by order number' })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Only orders created at or after this date',
    example: '2026-09-01T00:00:00.000Z',
  })
  @IsDateString()
  @IsOptional()
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Only orders created at or before this date',
    example: '2026-09-28T23:59:59.999Z',
  })
  @IsDateString()
  @IsOptional()
  to?: string;
}

export class OrderBuyerDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Tanvir Hossain' })
  name: string;

  @ApiProperty({ example: 'customer1@kinobecho.dev', nullable: true })
  email: string | null;

  @ApiProperty({ example: '+8801700000002', nullable: true })
  phone: string | null;
}

export class OrderVendorDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Rahim Electronics' })
  businessName: string;

  @ApiProperty({ example: 'rahim-electronics' })
  slug: string;

  @ApiProperty({ example: 'https://cdn.kinobecho.com/logos/rahim.png', nullable: true })
  logoUrl: string | null;
}

export class OrderItemDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  productVariantId: string;

  @ApiProperty({ example: 'Wireless Headphones' })
  productNameSnap: string;

  @ApiProperty({ example: 2 })
  qty: number;

  @ApiProperty({ example: '1250.00', description: 'Decimal serialised as a string' })
  unitPrice: string;

  @ApiProperty({ example: '2500.00', description: 'Decimal serialised as a string' })
  lineTotal: string;
}

export class OrderDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'ORD-20260928-8F3A1C' })
  orderNumber: string;

  @ApiProperty({ format: 'uuid', description: 'Shared by every order from one checkout' })
  orderGroupId: string;

  @ApiProperty({ enum: OrderStatus, enumName: 'OrderStatus' })
  status: OrderStatus;

  @ApiProperty({ enum: SaleChannel, enumName: 'SaleChannel' })
  saleChannel: SaleChannel;

  @ApiProperty({ example: '3200.00', description: 'Decimal serialised as a string' })
  subtotal: string;

  @ApiProperty({ example: '320.00', description: 'Decimal serialised as a string' })
  discountTotal: string;

  @ApiProperty({ example: '80.00', description: 'Decimal serialised as a string' })
  shippingFee: string;

  @ApiProperty({ example: '2960.00', description: 'Decimal serialised as a string' })
  grandTotal: string;

  @ApiProperty({ format: 'uuid' })
  buyerId: string;

  @ApiProperty({ format: 'uuid' })
  vendorId: string;

  @ApiProperty({ type: OrderBuyerDto })
  buyer: OrderBuyerDto;

  @ApiProperty({ type: OrderVendorDto })
  vendor: OrderVendorDto;

  @ApiProperty({ type: [OrderItemDto] })
  items: OrderItemDto[];

  @ApiProperty({ example: '2026-09-28T10:15:00.000Z' })
  createdAt: string;

  @ApiProperty({ example: '2026-09-28T10:15:00.000Z' })
  updatedAt: string;
}

export class PaginationMetaDto {
  @ApiProperty({ example: 137 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  limit: number;

  @ApiProperty({ example: 7 })
  totalPages: number;
}

export class PaginatedOrdersResponseDto {
  @ApiProperty({ type: [OrderDto] })
  items: OrderDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}
