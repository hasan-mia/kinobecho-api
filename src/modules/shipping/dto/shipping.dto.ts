import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { CourierProvider, ShipmentStatus } from '@prisma/client';

export class EstimateShippingQueryDto {
  @ApiPropertyOptional({ example: 'Dhaka' })
  @IsString()
  @IsOptional()
  district?: string;

  @ApiPropertyOptional({ example: 1500, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  weightGrams?: number;
}

export class CreateShipmentDto {
  @ApiProperty({ format: 'uuid' })
  @IsString()
  orderId: string;

  @ApiProperty({ enum: CourierProvider })
  @IsEnum(CourierProvider)
  courier: CourierProvider;
}

export class CreateManualShipmentDto {
  @ApiProperty({ format: 'uuid' })
  @IsString()
  orderId: string;

  @ApiProperty({ example: 'TRACK-12345' })
  @IsString()
  @MinLength(1)
  trackingCode: string;
}

export class UpdateShipmentStatusDto {
  @ApiProperty({ enum: ShipmentStatus })
  @IsEnum(ShipmentStatus)
  status: ShipmentStatus;

  @ApiPropertyOptional({ example: 'Handed to rider' })
  @IsString()
  @IsOptional()
  note?: string;
}

export class CreateShippingZoneDto {
  @ApiProperty({ example: 'Dhaka Division' })
  @IsString()
  @MinLength(1)
  name: string;

  @ApiProperty({ type: [String], example: ['Dhaka', 'Gazipur'] })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  districts: string[];

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  isActive = true;
}

export class UpdateShippingZoneDto {
  @ApiPropertyOptional({ example: 'Dhaka Division' })
  @IsString()
  @MinLength(1)
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  districts?: string[];

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

export class CreateShippingRateDto {
  @ApiProperty({ format: 'uuid' })
  @IsString()
  zoneId: string;

  @ApiProperty({ example: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minWeightGrams: number;

  @ApiPropertyOptional({ example: 1000, nullable: true })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  maxWeightGrams?: number | null;

  @ApiProperty({ example: 60 })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  fee: number;

  @ApiProperty({ example: 2 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  estimatedDays: number;
}