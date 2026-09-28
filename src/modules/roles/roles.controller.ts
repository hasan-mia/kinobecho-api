import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Delete,
  Param,
  UseGuards,
} from '@nestjs/common';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { AssignPermissionsDto } from './dto/assign-permissions.dto';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';

@ApiTags('roles')
@ApiBearerAuth()
@Controller('roles')
export class RolesController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @RequirePermissions('roles:manage')
  @ApiOperation({ summary: 'Get all roles' })
  @ApiResponse({ status: 200, description: 'List of all roles' })
  async findAll() {
    return this.rolesService.findAll();
  }

  @Post()
  @RequirePermissions('roles:manage')
  @ApiOperation({ summary: 'Create a new role' })
  @ApiResponse({ status: 201, description: 'Role created' })
  async create(@Body() createRoleDto: CreateRoleDto) {
    return this.rolesService.create(createRoleDto);
  }

  @Get(':id')
  @RequirePermissions('roles:read')
  @ApiOperation({ summary: 'Get a role by ID' })
  @ApiResponse({ status: 200, description: 'The role' })
  async findOne(@Param('id') id: string) {
    return this.rolesService.findOne(id);
  }

  @Patch(':id')
  @RequirePermissions('roles:manage')
  @ApiOperation({ summary: 'Update a role' })
  @ApiResponse({ status: 200, description: 'Updated role' })
  async update(@Param('id') id: string, @Body() updateRoleDto: UpdateRoleDto) {
    return this.rolesService.update(id, updateRoleDto);
  }

  @Delete(':id')
  @RequirePermissions('roles:manage')
  @ApiOperation({ summary: 'Delete a role' })
  @ApiResponse({ status: 200, description: 'Role deleted' })
  async remove(@Param('id') id: string) {
    return this.rolesService.remove(id);
  }

  @Patch(':id/permissions')
  @RequirePermissions('roles:manage')
  @ApiOperation({ summary: 'Assign permissions to a role' })
  @ApiResponse({ status: 200, description: 'Permissions assigned' })
  async assignPermissions(
    @Param('id') id: string,
    @Body() assignPermissionsDto: AssignPermissionsDto,
  ) {
    return this.rolesService.assignPermissions(id, assignPermissionsDto);
  }

  @Get('permissions/catalog')
  @RequirePermissions('roles:manage')
  @ApiOperation({ summary: 'Get all available permissions' })
  @ApiResponse({ status: 200, description: 'Permission catalog' })
  async getPermissionCatalog() {
    return {
      permissions: [
        { key: 'users:read', description: 'Read users' },
        { key: 'users:write', description: 'Write users' },
        { key: 'users:delete', description: 'Delete users' },
        { key: 'roles:manage', description: 'Manage roles' },
        { key: 'roles:read', description: 'Read roles' },
        { key: 'flights:search', description: 'Search flights' },
        { key: 'flights:read', description: 'Read flights' },
        { key: 'bookings:create', description: 'Create bookings' },
        { key: 'bookings:read', description: 'Read bookings' },
        { key: 'bookings:cancel', description: 'Cancel bookings' },
        { key: 'bookings:change', description: 'Change bookings' },
        { key: 'payments:create', description: 'Create payments' },
        { key: 'payments:refund', description: 'Refund payments' },
        { key: 'payments:read', description: 'Read payments' },
        { key: 'webhooks:manage', description: 'Manage webhooks' },
      ],
    };
  }
}