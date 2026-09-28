import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';

export class CreateThreadDto {
  @ApiProperty({ required: false, description: 'Vendor ID for BUYER_VENDOR thread type' })
  @IsOptional()
  @IsString()
  vendorId?: string;
}

export class SendMessageDto {
  @ApiProperty({ description: 'Thread ID' })
  @IsString()
  threadId: string;

  @ApiProperty({ required: false, description: 'Message content' })
  @IsOptional()
  @IsString()
  content?: string;

  @ApiProperty({ required: false, description: 'Attachment URL' })
  @IsOptional()
  @IsString()
  attachmentUrl?: string;
}

export class TypingDto {
  @ApiProperty({ description: 'Thread ID' })
  @IsString()
  threadId: string;
}

export class ReadMessageDto {
  @ApiProperty({ description: 'Thread ID' })
  @IsString()
  threadId: string;

  @ApiProperty({ description: 'Message ID to mark as read up to' })
  @IsString()
  messageId: string;
}

export class JoinThreadDto {
  @ApiProperty({ description: 'Thread ID' })
  @IsString()
  threadId: string;
}