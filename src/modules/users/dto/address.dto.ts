import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsPhoneNumber,
  IsString,
  MinLength,
} from 'class-validator';

export class CreateAddressDto {
  @ApiPropertyOptional({ example: 'Home' })
  @IsString()
  @IsOptional()
  label?: string;

  @ApiProperty({ example: 'Ayesha Rahman' })
  @IsString()
  @MinLength(2)
  recipientName: string;

  @ApiProperty({ example: '+8801700000001' })
  @IsString()
  phone: string;

  @ApiProperty({ example: 'House 12, Road 5, Dhanmondi' })
  @IsString()
  line1: string;

  @ApiPropertyOptional({ example: 'Panhathazari' })
  @IsString()
  @IsOptional()
  line2?: string;

  @ApiProperty({ example: 'Dhaka' })
  @IsString()
  city: string;

  @ApiPropertyOptional({ example: 'Dhaka' })
  @IsString()
  @IsOptional()
  district?: string;

  @ApiPropertyOptional({ example: '1209' })
  @IsString()
  @IsOptional()
  postalCode?: string;

  @ApiPropertyOptional({ example: 'BD', default: 'BD' })
  @IsString()
  @IsOptional()
  country?: string;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}

export class UpdateAddressDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  label?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  recipientName?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  line1?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  line2?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  city?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  district?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  postalCode?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}
