import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { Locale, UserRole } from '@prisma/client';
import { ProductService } from './product.service';
import { ProductImageService } from './product-image.service';
import { ALLOWED_MIME_SIZES } from '../storage/storage.service';

const MAX_UPLOAD_BYTES = Math.max(...Object.values(ALLOWED_MIME_SIZES));
import {
  CreateProductDto,
  ListProductsQueryDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/product.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { LocaleParam } from '../../common/decorators/locale.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/guards/roles.guard';

@ApiTags('products')
@Controller('products')
export class ProductController {
  constructor(
    private readonly productService: ProductService,
    private readonly productImageService: ProductImageService,
  ) {}

  @Post()
  @Roles(UserRole.VENDOR, UserRole.VENDOR_STAFF)
  @RequirePermissions('product:create')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a product with variants and price tiers' })
  @ApiResponse({ status: 201, description: 'Product created' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() createProductDto: CreateProductDto,
  ) {
    return this.productService.create(user, createProductDto);
  }

  @Patch(':id')
  @Roles(
    UserRole.VENDOR,
    UserRole.VENDOR_STAFF,
    UserRole.ADMIN,
    UserRole.SUPER_ADMIN,
  )
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Update a product (own product for vendors, any product for admins with product:update:any)',
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() updateProductDto: UpdateProductDto,
  ) {
    return this.productService.update(user, id, updateProductDto);
  }

  @Patch(':id/variants/:variantId')
  @Roles(
    UserRole.VENDOR,
    UserRole.VENDOR_STAFF,
    UserRole.ADMIN,
    UserRole.SUPER_ADMIN,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a product variant (stock/price)' })
  updateVariant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('variantId') variantId: string,
    @Body() updateVariantDto: UpdateVariantDto,
  ) {
    return this.productService.updateVariant(
      user,
      id,
      variantId,
      updateVariantDto,
    );
  }

  @Delete(':id')
  @Roles(
    UserRole.VENDOR,
    UserRole.VENDOR_STAFF,
    UserRole.ADMIN,
    UserRole.SUPER_ADMIN,
  )
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Soft delete a product' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.productService.remove(user, id);
  }

  @Post(':id/images')
  @Roles(
    UserRole.VENDOR,
    UserRole.VENDOR_STAFF,
    UserRole.ADMIN,
    UserRole.SUPER_ADMIN,
  )
  @UseInterceptors(
    FilesInterceptor('files', 10, {
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
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
        },
      },
    },
  })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Upload images for a product' })
  addImages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.productImageService.addImages(user, id, files);
  }

  @Patch(':id/images/:imageId/set-primary')
  @Roles(
    UserRole.VENDOR,
    UserRole.VENDOR_STAFF,
    UserRole.ADMIN,
    UserRole.SUPER_ADMIN,
  )
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set a product image as primary' })
  setPrimaryImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('imageId') imageId: string,
  ) {
    return this.productImageService.setPrimary(user, id, imageId);
  }

  @Delete(':id/images/:imageId')
  @Roles(
    UserRole.VENDOR,
    UserRole.VENDOR_STAFF,
    UserRole.ADMIN,
    UserRole.SUPER_ADMIN,
  )
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a product image' })
  removeImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('imageId') imageId: string,
  ) {
    return this.productImageService.remove(user, id, imageId);
  }

  @Get()
  @Public()
  @ApiOperation({ summary: 'List products (?lang=bn to translate)' })
  findAll(@Query() query: ListProductsQueryDto, @LocaleParam() locale: Locale) {
    return this.productService.findAll(query, locale);
  }

  @Get(':slug')
  @Public()
  @ApiOperation({ summary: 'Get a product by slug (?lang=bn to translate)' })
  findBySlug(@Param('slug') slug: string, @LocaleParam() locale: Locale) {
    return this.productService.findBySlug(slug, locale);
  }
}
