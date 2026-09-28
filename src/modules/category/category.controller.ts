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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CategoryService } from './category.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto/category.dto';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';

@ApiTags('categories')
@Controller('categories')
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  @Post()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('category:manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a category' })
  @ApiResponse({ status: 201, description: 'Category created' })
  create(@Body() createCategoryDto: CreateCategoryDto) {
    return this.categoryService.create(createCategoryDto);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('category:manage')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a category' })
  update(@Param('id') id: string, @Body() updateCategoryDto: UpdateCategoryDto) {
    return this.categoryService.update(id, updateCategoryDto);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('category:manage')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a category (blocked if it has children or products)' })
  remove(@Param('id') id: string) {
    return this.categoryService.remove(id);
  }

  @Get()
  @Public()
  @ApiQuery({
    name: 'includeInactive',
    required: false,
    type: Boolean,
  })
  @ApiOperation({ summary: 'Get the category tree' })
  getTree(
    @Query('includeInactive') includeInactive?: string | undefined,
  ) {
    return this.categoryService.getTree(includeInactive === 'true');
  }

  @Get(':slug')
  @Public()
  @ApiOperation({ summary: 'Get a category by slug' })
  findBySlug(@Param('slug') slug: string) {
    return this.categoryService.findBySlug(slug);
  }
}
