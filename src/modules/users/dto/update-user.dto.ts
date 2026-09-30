import { IsEmail, IsEnum, IsString, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Locale } from '@prisma/client';

export class UpdateUserDto {
  @ApiProperty({ example: 'John Doe', required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({ example: 'user@example.com', required: false })
  @IsString()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({
    enum: Locale,
    description:
      'Language for notifications. Persisted rather than taken from a request ' +
      'header, because notifications are delivered out of band.',
  })
  @IsEnum(Locale)
  @IsOptional()
  preferredLocale?: Locale;
}
