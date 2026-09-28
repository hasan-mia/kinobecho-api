import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { UserRole, CampaignAudience } from '@prisma/client';

export class RegisterDeviceTokenDto {
  @ApiProperty({ description: 'FCM device token' })
  @IsString()
  token: string;

  @ApiProperty({ description: 'Platform', enum: ['android', 'ios', 'web'] })
  @IsEnum(['android', 'ios', 'web'])
  platform: 'android' | 'ios' | 'web';
}

export class SendTransactionalEmailDto {
  @ApiProperty({ description: 'Recipient user ID' })
  @IsString()
  userId: string;

  @ApiProperty({ description: 'Email subject' })
  @IsString()
  subject: string;

  @ApiProperty({ description: 'Template key (e.g., order-confirmation, kyc-approved, promo-blast, otp)' })
  @IsString()
  templateKey: string;

  @ApiProperty({ description: 'Template variables', type: Object })
  @IsOptional()
  payload?: Record<string, string | number>;
}

export class CreatePromotionCampaignDto {
  @ApiProperty({ description: 'Campaign title' })
  @IsString()
  title: string;

  @ApiProperty({ description: 'Email subject' })
  @IsString()
  subject: string;

  @ApiProperty({ description: 'Email body HTML' })
  @IsString()
  bodyHtml: string;

  @ApiProperty({ description: 'Audience type', enum: CampaignAudience })
  @IsEnum(CampaignAudience)
  audience: CampaignAudience;

  @ApiProperty({ description: 'Target filter for CUSTOM_SEGMENT', required: false })
  @IsOptional()
  @Type(() => Object)
  targetFilter?: Record<string, unknown>;

  @ApiProperty({ description: 'Scheduled send time', required: false })
  @IsOptional()
  @Type(() => Date)
  scheduledAt?: Date;
}

export class SendPromotionCampaignDto {
  @ApiProperty({ description: 'Campaign ID' })
  @IsString()
  campaignId: string;
}

export class PromotionCampaignQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  page?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @Type(() => Number)
  limit?: number;
}