import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { StorageService, ALLOWED_MIME_SIZES } from './storage.service';
import { UploadFileDto } from './dto/upload-file.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { buildStoragePath } from './storage-path.util';

const MAX_UPLOAD_BYTES = Math.max(...Object.values(ALLOWED_MIME_SIZES));

@ApiTags('storage')
@ApiBearerAuth()
@Controller('storage')
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'ownerType', 'ownerId'],
      properties: {
        file: { type: 'string', format: 'binary' },
        ownerType: { type: 'string', example: 'PRODUCT_IMAGE' },
        ownerId: { type: 'string', format: 'uuid' },
      },
    },
  })
  @ApiOperation({ summary: 'Upload a file' })
  @ApiResponse({ status: 201, description: 'File uploaded' })
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: UploadFileDto,
  ) {
    return this.storageService.uploadFile(
      file,
      buildStoragePath(body.ownerType, body.ownerId, file),
      {
        ownerType: body.ownerType,
        ownerId: body.ownerId,
        uploadedById: user.id,
      },
    );
  }

  @Get('file/:id/signed-url')
  @ApiOperation({ summary: 'Get a temporary signed URL for a stored file' })
  signedUrl(@Param('id') id: string) {
    return this.storageService.getSignedUrlForFile(id);
  }

  @Delete('file/:id')
  @ApiOperation({ summary: 'Delete a stored file' })
  remove(@Param('id') id: string) {
    return this.storageService.deleteFile(id);
  }
}
