import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReviewStatus } from '@prisma/client';

export class CreateQuestionDto {
  @ApiProperty({ example: 'Does this ship with the original warranty card?' })
  @IsString()
  @Length(5, 1000)
  question: string;
}

export class CreateAnswerDto {
  @ApiProperty({ example: 'Yes, sealed in the box.' })
  @IsString()
  @Length(2, 2000)
  answer: string;
}

export class ModerateQuestionDto {
  @ApiProperty({ enum: ReviewStatus, description: 'APPROVED or REJECTED' })
  @IsEnum(ReviewStatus)
  status: ReviewStatus;

  @ApiPropertyOptional({ description: 'Required when rejecting' })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason?: string;
}

export class ListQuestionsQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit = 20;
}
