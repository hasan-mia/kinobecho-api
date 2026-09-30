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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { BannerPlacement, Locale, UserRole } from '@prisma/client';
import { CmsService } from './cms.service';
import {
  BannerIdParamDto,
  CreateBannerDto,
  CreateSectionDto,
  ListBannersQueryDto,
  ListSectionsQueryDto,
  ReorderDto,
  SectionIdParamDto,
  UpdateBannerDto,
  UpdateSectionDto,
  UploadBannerImageDto,
} from './dto/cms.dto';
import { Public } from '../../common/decorators/public.decorator';
import { LocaleParam } from '../../common/decorators/locale.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { ALLOWED_MIME_SIZES } from '../storage/storage.service';

const MAX_UPLOAD_BYTES = Math.max(...Object.values(ALLOWED_MIME_SIZES));

@ApiTags('cms')
@Controller('cms')
export class CmsController {
  constructor(private readonly cmsService: CmsService) {}

  @Get('home')
  @Public()
  @ApiOperation({ summary: 'Get the storefront home payload (banners + resolved sections)' })
  getHome(@LocaleParam() locale: Locale) {
    return this.cmsService.getHome(locale);
  }

  // -------------------------------------------------------------------------
  // Banners
  // -------------------------------------------------------------------------

  @Get('banners')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('cms:manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List banners, including inactive and scheduled ones' })
  listBanners(@Query() query: ListBannersQueryDto) {
    return this.cmsService.listBanners(query);
  }

  @Get('banners/:id')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('cms:manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a banner' })
  getBanner(@Param() params: BannerIdParamDto) {
    return this.cmsService.getBanner(params.id);
  }

  @Post('banners')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('cms:manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a banner' })
  createBanner(@Body() dto: CreateBannerDto) {
    return this.cmsService.createBanner(dto);
  }

  @Patch('banners/:id')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('cms:manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a banner' })
  updateBanner(@Param() params: BannerIdParamDto, @Body() dto: UpdateBannerDto) {
    return this.cmsService.updateBanner(params.id, dto);
  }

  @Delete('banners/:id')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('cms:manage')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a banner' })
  removeBanner(@Param() params: BannerIdParamDto) {
    return this.cmsService.removeBanner(params.id);
  }

  @Patch('banners/:placement/reorder')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('cms:manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reorder the banners within a placement' })
  reorderBanners(
    @Param('placement') placement: BannerPlacement,
    @Body() dto: ReorderDto,
  ) {
    return this.cmsService.reorderBanners(placement, dto.items);
  }

  @Post('banners/:id/image')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('cms:manage')
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
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Upload a banner creative and return its resized variants' })
  uploadBannerImage(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: BannerIdParamDto,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadBannerImageDto,
  ) {
    return this.cmsService.uploadBannerImage(
      file,
      dto.target,
      params.id,
      user.id,
    );
  }

  // -------------------------------------------------------------------------
  // Sections
  // -------------------------------------------------------------------------

  @Get('sections')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('cms:manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List home sections' })
  listSections(@Query() query: ListSectionsQueryDto) {
    return this.cmsService.listSections(query);
  }

  // Declared before `sections/:id` so the literal path wins: the router matches
  // in declaration order and "reorder" is not a section id.
  @Patch('sections/reorder')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('cms:manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reorder the home sections' })
  reorderSections(@Body() dto: ReorderDto) {
    return this.cmsService.reorderSections(dto.items);
  }

  @Get('sections/:id')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('cms:manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get a home section' })
  getSection(@Param() params: SectionIdParamDto) {
    return this.cmsService.getSection(params.id);
  }

  @Post('sections')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('cms:manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a home section' })
  createSection(@Body() dto: CreateSectionDto) {
    return this.cmsService.createSection(dto);
  }

  @Patch('sections/:id')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('cms:manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a home section' })
  updateSection(@Param() params: SectionIdParamDto, @Body() dto: UpdateSectionDto) {
    return this.cmsService.updateSection(params.id, dto);
  }

  @Delete('sections/:id')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('cms:manage')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a home section' })
  removeSection(@Param() params: SectionIdParamDto) {
    return this.cmsService.removeSection(params.id);
  }
}
