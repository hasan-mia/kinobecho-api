import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { VendorService } from './vendor.service';
import { VendorKycService } from './vendor-kyc.service';
import { ALLOWED_MIME_SIZES } from '../storage/storage.service';

const MAX_UPLOAD_BYTES = Math.max(...Object.values(ALLOWED_MIME_SIZES));

function normalizeDocumentTypes(value?: string[] | string): string[] {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}
import {
  ApplyVendorDto,
  ListVendorsQueryDto,
  SuspendVendorDto,
  UpdateVendorDto,
} from './dto/vendor.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/guards/roles.guard';

@ApiTags('vendors')
@Controller('vendors')
export class VendorController {
  constructor(
    private readonly vendorService: VendorService,
    private readonly vendorKycService: VendorKycService,
  ) {}

  @Post('apply')
  @Roles(UserRole.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Apply as a vendor' })
  @ApiResponse({ status: 201, description: 'Vendor application created' })
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Body() applyVendorDto: ApplyVendorDto,
  ) {
    return this.vendorService.apply(user, applyVendorDto);
  }

  @Get('me')
  @Roles(UserRole.VENDOR, UserRole.VENDOR_STAFF)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the current vendor's profile" })
  getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.vendorService.getMyVendor(user);
  }

  @Patch('me')
  @Roles(UserRole.VENDOR, UserRole.VENDOR_STAFF)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update the current vendor's profile" })
  updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() updateVendorDto: UpdateVendorDto,
  ) {
    return this.vendorService.updateMyVendor(user, updateVendorDto);
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('vendor:list')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List vendors (admin)' })
  findAll(@Query() query: ListVendorsQueryDto) {
    return this.vendorService.findAll(query);
  }

  @Get(':slug')
  @Public()
  @ApiOperation({ summary: 'Get a public vendor storefront' })
  findBySlug(@Param('slug') slug: string) {
    return this.vendorService.getPublicBySlug(slug);
  }

  @Get(':id/detail')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('vendor:list')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a vendor by id (admin)' })
  findOne(@Param('id') id: string) {
    return this.vendorService.findOne(id);
  }

  @Patch(':id/approve')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('vendor:approve')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Approve a vendor application' })
  approve(@Param('id') id: string) {
    return this.vendorService.approve(id);
  }

  @Patch(':id/suspend')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('vendor:suspend')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Suspend a vendor' })
  suspend(
    @Param('id') id: string,
    @Body() suspendVendorDto: SuspendVendorDto,
  ) {
    return this.vendorService.suspend(id, suspendVendorDto);
  }

  @Patch(':id/reactivate')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('vendor:approve')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reactivate a suspended vendor' })
  reactivate(@Param('id') id: string) {
    return this.vendorService.reactivate(id);
  }

  @Post('me/kyc-documents')
  @Roles(UserRole.VENDOR, UserRole.VENDOR_STAFF)
  @UseInterceptors(
    FilesInterceptor('files', 5, {
      storage: memoryStorage(),
      limits: { fileSize: MAX_UPLOAD_BYTES },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['files'],
      properties: {
        files: { type: 'array', items: { type: 'string', format: 'binary' } },
        documentTypes: {
          type: 'array',
          items: { type: 'string' },
          example: ['TRADE_LICENSE', 'NID'],
        },
      },
    },
  })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Upload KYC documents for the current vendor' })
  uploadKycDocuments(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFiles() files: Express.Multer.File[],
    @Body('documentTypes') documentTypes?: string[] | string,
  ) {
    return this.vendorKycService.uploadDocuments(
      user,
      files,
      normalizeDocumentTypes(documentTypes),
    );
  }

  @Get('me/kyc-documents')
  @Roles(UserRole.VENDOR, UserRole.VENDOR_STAFF)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List the current vendor KYC documents' })
  listOwnKycDocuments(@CurrentUser() user: AuthenticatedUser) {
    return this.vendorKycService.listOwnDocuments(user);
  }

  @Get(':id/kyc-documents')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('vendor:approve')
  @ApiBearerAuth()
  @ApiOperation({ summary: "List a vendor's KYC documents with signed URLs" })
  listKycDocuments(@Param('id') id: string) {
    return this.vendorKycService.listDocuments(id);
  }
}
