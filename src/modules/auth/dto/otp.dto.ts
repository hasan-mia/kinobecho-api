import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, Length, Matches } from 'class-validator';
import { OtpPurpose } from '@prisma/client';

export class RequestOtpDto {
  @ApiProperty({
    example: '01712345678',
    description:
      'Bangladeshi phone number. Accepts 01XXXXXXXXX, 8801… and +8801…; stored as E.164.',
  })
  @IsString()
  @Length(6, 20)
  phone: string;

  @ApiProperty({
    enum: OtpPurpose,
    example: OtpPurpose.LOGIN,
    description: 'What the code may be used for. Codes are not interchangeable.',
  })
  @IsEnum(OtpPurpose)
  purpose: OtpPurpose;
}

export class VerifyOtpDto {
  @ApiProperty({ example: '01712345678' })
  @IsString()
  @Length(6, 20)
  phone: string;

  @ApiProperty({ example: '123456', description: 'Six-digit code from SMS' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be six digits' })
  code: string;

  @ApiProperty({ enum: OtpPurpose, example: OtpPurpose.LOGIN })
  @IsEnum(OtpPurpose)
  purpose: OtpPurpose;
}

export class ResetPasswordDto {
  @ApiProperty({ example: '01712345678' })
  @IsString()
  @Length(6, 20)
  phone: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be six digits' })
  code: string;

  @ApiProperty({ example: 'NewSecurePass123!' })
  @IsString()
  @Matches(/^(?=.*[A-Z])(?=.*\d).{8,}$/, {
    message:
      'newPassword must be at least 8 characters and contain an uppercase letter and a digit',
  })
  newPassword: string;
}

export class VerifyPhoneOtpDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be six digits' })
  code: string;

  @ApiPropertyOptional({
    example: 'LOGIN',
    description: 'Purpose the code was requested with. Defaults to LOGIN.',
  })
  @IsEnum(OtpPurpose)
  @IsOptional()
  purpose?: OtpPurpose;
}
