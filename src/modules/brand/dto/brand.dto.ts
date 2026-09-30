import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  Length,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBrandDto {
  @ApiProperty({ example: 'Samsung' })
  @IsString()
  @Length(2, 120)
  name: string;

  @ApiPropertyOptional({ example: 'samsung', description: 'Derived from name if omitted' })
  @IsOptional()
  @IsString()
  @Length(2, 140)
  slug?: string;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/samsung.webp' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  @Length(0, 500)
  logoUrl?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateBrandDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(2, 140)
  slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({ require_tld: false })
  @Length(0, 500)
  logoUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ListBrandsQueryDto {
  @ApiPropertyOptional({ description: 'Include inactive brands (admin listing)' })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  includeInactive?: boolean;
}
