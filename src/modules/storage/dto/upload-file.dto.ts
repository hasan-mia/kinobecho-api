import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class UploadFileDto {
  @ApiProperty({
    example: 'PRODUCT_IMAGE',
    description:
      'One of VENDOR_KYC | PRODUCT_IMAGE | CHAT_ATTACHMENT | AVATAR | CATEGORY_IMAGE',
  })
  @IsString()
  @IsNotEmpty()
  ownerType: string;

  @ApiProperty({ description: 'Id of the record that owns the file' })
  @IsString()
  @IsNotEmpty()
  ownerId: string;
}
