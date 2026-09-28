import { IsString, IsOptional, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateRoleDto {
  @ApiProperty({ example: 'manager' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'Can manage bookings and customers' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: ['flights:search', 'bookings:create'],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  permissions?: string[];
}