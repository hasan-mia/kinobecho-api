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
import { KycStatus, VendorStatus } from '@prisma/client';

export class ApplyVendorDto {
  @ApiProperty({ example: 'KinoBecho Electronics' })
  @IsString()
  @MinLength(2)
  businessName: string;

  @ApiPropertyOptional({ example: 'Consumer electronics wholesale supplier' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ example: 'https://cdn.kinobecho.com/logos/ebay.png' })
  @IsString()
  @IsOptional()
  logoUrl?: string;

  @ApiPropertyOptional({ example: 'https://cdn.kinobecho.com/banners/ebay.jpg' })
  @IsString()
  @IsOptional()
  bannerUrl?: string;

  @ApiPropertyOptional({ example: 'BKASH' })
  @IsString()
  @IsOptional()
  payoutMethod?: string;

  @ApiPropertyOptional({ example: { bkashNumber: '01XXXXXXXXX' } })
  @IsOptional()
  payoutAccountInfo?: Record<string, unknown>;
}

export class UpdateVendorDto {
  @ApiPropertyOptional({ example: 'KinoBecho Electronics Pvt Ltd' })
  @IsString()
  @IsOptional()
  businessName?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  logoUrl?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  bannerUrl?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  payoutMethod?: string;

  @ApiPropertyOptional()
  @IsOptional()
  payoutAccountInfo?: Record<string, unknown>;
}

export class ListVendorsQueryDto {
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

  @ApiPropertyOptional({ enum: VendorStatus })
  @IsEnum(VendorStatus)
  @IsOptional()
  status?: VendorStatus;

  @ApiPropertyOptional({ enum: KycStatus })
  @IsEnum(KycStatus)
  @IsOptional()
  kycStatus?: KycStatus;

  @ApiPropertyOptional({ description: 'Filter by business name or slug' })
  @IsString()
  @IsOptional()
  search?: string;
}

export class VendorIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id: string;
}

export class SuspendVendorDto {
  @ApiPropertyOptional({ example: 'Repeated counterfeit complaints' })
  @IsString()
  @IsOptional()
  reason?: string;
}
