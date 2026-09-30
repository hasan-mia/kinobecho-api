import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Locale, UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { LocaleParam } from '../../common/decorators/locale.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { BrandService } from './brand.service';
import {
  CreateBrandDto,
  ListBrandsQueryDto,
  UpdateBrandDto,
} from './dto/brand.dto';

@ApiTags('brands')
@Controller('brands')
export class BrandController {
  constructor(private readonly brands: BrandService) {}

  /**
   * Public. Deliberately takes no query parameters: `includeInactive` on a
   * public route would let any caller list the brands the merchandising team
   * has hidden. Admins get the inactive ones from `/brands/admin`.
   */
  @Get()
  @Public()
  @ApiOperation({ summary: 'List active brands' })
  list(@LocaleParam() locale: Locale) {
    return this.brands.list({}, locale);
  }

  @Get('admin')
  @ApiBearerAuth()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('brand:manage')
  @ApiOperation({ summary: 'List every brand, active or not' })
  listAll(@Query() query: ListBrandsQueryDto) {
    return this.brands.list(query);
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'One brand' })
  findOne(@Param('id', ParseUUIDPipe) id: string, @LocaleParam() locale: Locale) {
    return this.brands.findOne(id, locale);
  }

  @Post()
  @ApiBearerAuth()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('brand:manage')
  @ApiOperation({ summary: 'Create a brand' })
  create(@Body() dto: CreateBrandDto) {
    return this.brands.create(dto);
  }

  @Put(':id')
  @ApiBearerAuth()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('brand:manage')
  @ApiOperation({ summary: 'Update a brand' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBrandDto,
  ) {
    return this.brands.update(id, dto);
  }

  @Patch(':id')
  @ApiBearerAuth()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('brand:manage')
  @ApiOperation({ summary: 'Alias of PUT, for clients that prefer PATCH' })
  patch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBrandDto,
  ) {
    return this.brands.update(id, dto);
  }

  @Delete(':id')
  @ApiBearerAuth()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('brand:manage')
  @ApiOperation({
    summary: 'Deactivate a brand',
    description:
      'Deactivates rather than deletes: products reference brands with ' +
      'onDelete SetNull, so deleting would strip the brand off the catalogue.',
  })
  @ApiResponse({ status: 200, description: 'Brand marked inactive' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.brands.remove(id);
  }
}
