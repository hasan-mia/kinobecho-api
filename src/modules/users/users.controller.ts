import {
  Controller,
  Get,
  Body,
  Patch,
  Param,
  Post,
  Delete,
  UseGuards,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '@prisma/client';
import { CreateAddressDto, UpdateAddressDto } from './dto/address.dto';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @RequirePermissions('users:read')
  @ApiOperation({ summary: 'Get all users' })
  @ApiResponse({ status: 200, description: 'List of users' })
  async findAll() {
    return this.usersService.findAll();
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'User profile' })
  async getProfile(@CurrentUser() user: User) {
    return this.usersService.findOne(user.id);
  }

  @Get(':id')
  @RequirePermissions('users:read')
  @ApiOperation({ summary: 'Get user by ID' })
  @ApiResponse({ status: 200, description: 'User details' })
  async findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Get('me/addresses')
  @ApiOperation({ summary: 'List the current user addresses' })
  listAddresses(@CurrentUser() user: User) {
    return this.usersService.listAddresses(user.id);
  }

  @Post('me/addresses')
  @ApiOperation({ summary: 'Create an address for the current user' })
  createAddress(@CurrentUser() user: User, @Body() createAddressDto: CreateAddressDto) {
    return this.usersService.createAddress(user.id, createAddressDto);
  }

  @Patch('me/addresses/:id')
  @ApiOperation({ summary: 'Update one of the current user addresses' })
  updateAddress(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() updateAddressDto: UpdateAddressDto,
  ) {
    return this.usersService.updateAddress(user.id, id, updateAddressDto);
  }

  @Delete('me/addresses/:id')
  @ApiOperation({ summary: 'Delete one of the current user addresses' })
  removeAddress(@CurrentUser() user: User, @Param('id') id: string) {
    return this.usersService.removeAddress(user.id, id);
  }

  @Patch(':id/role')
  @RequirePermissions('roles:manage')
  @ApiOperation({ summary: 'Assign role to user' })
  @ApiResponse({ status: 200, description: 'User role updated' })
  async assignRole(
    @Param('id') id: string,
    @Body() body: { roleId: string },
  ) {
    return this.usersService.assignRole(id, body.roleId);
  }

  @Delete(':id')
  @RequirePermissions('users:delete')
  @ApiOperation({ summary: 'Delete user' })
  @ApiResponse({ status: 200, description: 'User deleted' })
  async remove(@Param('id') id: string) {
    return this.usersService.remove(id);
  }
}