import { IsArray, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AssignPermissionsDto {
  @ApiProperty({
    example: ['flights:search', 'bookings:create', 'bookings:cancel'],
    description: 'Array of permission keys to assign',
  })
  @IsArray()
  @IsString({ each: true })
  permissions: string[];
}