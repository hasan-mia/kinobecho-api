import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { Public } from '../../common/decorators/public.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { ShippingRateService } from './shipping-rate.service';
import { ShippingService } from './shipping.service';
import {
  CreateShippingRateDto,
  CreateShippingZoneDto,
  EstimateShippingQueryDto,
  UpdateShippingZoneDto,
} from './dto/shipping.dto';

@ApiTags('shipping')
@ApiBearerAuth()
@Controller('shipping')
export class ShippingController {
  constructor(
    private readonly shippingService: ShippingService,
    private readonly rates: ShippingRateService,
    private readonly prisma: PrismaService,
  ) {}

  // -------------------------------------------------------------------------
  // Public
  // -------------------------------------------------------------------------

  @Get('estimate')
  @Public()
  @ApiOperation({ summary: 'Estimate shipping for a district and weight' })
  @ApiResponse({ status: 200, description: 'Fee and delivery estimate' })
  async estimate(@Query() query: EstimateShippingQueryDto) {
    const weightGrams = query.weightGrams ?? 500;

    const estimate = await this.rates.calculateFee(
      [{ weightGrams, qty: 1 }],
      { district: query.district ?? null },
    );

    return {
      district: query.district ?? null,
      weightGrams,
      zone: estimate.zoneName,
      fee: estimate.fee.toFixed(2),
      estimatedDays: estimate.estimatedDays,
    };
  }

  // -------------------------------------------------------------------------
  // Pathao admin helpers
  // -------------------------------------------------------------------------

  @Get('pathao/cities')
  @RequirePermissions('shipping:manage')
  @ApiOperation({ summary: 'List Pathao delivery cities' })
  listPathaoCities() {
    return this.shippingService.listPathaoCities();
  }

  @Get('pathao/cities/:cityId/zones')
  @RequirePermissions('shipping:manage')
  @ApiOperation({ summary: 'List Pathao zones for a city' })
  listPathaoZones(@Param('cityId') cityId: string) {
    return this.shippingService.listPathaoZones(cityId);
  }

  // -------------------------------------------------------------------------
  // Zone / rate CRUD
  // -------------------------------------------------------------------------

  @Get('zones')
  @RequirePermissions('shipping:manage')
  @ApiOperation({ summary: 'List shipping zones with their rates' })
  listZones() {
    return this.prisma.shippingZone.findMany({
      include: { rates: { orderBy: { minWeightGrams: 'asc' } } },
      orderBy: { name: 'asc' },
    });
  }

  @Post('zones')
  @RequirePermissions('shipping:manage')
  @ApiOperation({ summary: 'Create a shipping zone' })
  async createZone(@Body() dto: CreateShippingZoneDto) {
    const existing = await this.prisma.shippingZone.findFirst({
      where: { name: dto.name },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('A shipping zone with this name already exists');
    }

    return this.prisma.shippingZone.create({
      data: {
        name: dto.name,
        districts: dto.districts,
        isActive: dto.isActive,
      },
    });
  }

  @Patch('zones/:id')
  @RequirePermissions('shipping:manage')
  @ApiOperation({ summary: 'Update a shipping zone' })
  async updateZone(@Param('id') id: string, @Body() dto: UpdateShippingZoneDto) {
    await this.requireZone(id);

    return this.prisma.shippingZone.update({
      where: { id },
      data: {
        name: dto.name,
        districts: dto.districts,
        isActive: dto.isActive,
      },
    });
  }

  @Delete('zones/:id')
  @RequirePermissions('shipping:manage')
  @ApiOperation({ summary: 'Delete a shipping zone and its rates' })
  async deleteZone(@Param('id') id: string) {
    await this.requireZone(id);

    await this.prisma.shippingZone.delete({ where: { id } });
    return { message: 'Shipping zone deleted' };
  }

  @Post('rates')
  @RequirePermissions('shipping:manage')
  @ApiOperation({ summary: 'Add a weight band to a shipping zone' })
  async createRate(@Body() dto: CreateShippingRateDto) {
    await this.requireZone(dto.zoneId);

    if (
      dto.maxWeightGrams !== undefined &&
      dto.maxWeightGrams !== null &&
      dto.maxWeightGrams < dto.minWeightGrams
    ) {
      throw new ConflictException(
        'maxWeightGrams must be greater than or equal to minWeightGrams',
      );
    }

    return this.prisma.shippingRate.create({
      data: {
        zoneId: dto.zoneId,
        minWeightGrams: dto.minWeightGrams,
        maxWeightGrams: dto.maxWeightGrams ?? null,
        fee: new Prisma.Decimal(dto.fee),
        estimatedDays: dto.estimatedDays,
      },
    });
  }

  @Delete('rates/:id')
  @RequirePermissions('shipping:manage')
  @ApiOperation({ summary: 'Delete a shipping rate' })
  async deleteRate(@Param('id') id: string) {
    const rate = await this.prisma.shippingRate.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!rate) {
      throw new NotFoundException('Shipping rate not found');
    }

    await this.prisma.shippingRate.delete({ where: { id } });
    return { message: 'Shipping rate deleted' };
  }

  private async requireZone(id: string) {
    const zone = await this.prisma.shippingZone.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!zone) {
      throw new NotFoundException('Shipping zone not found');
    }

    return zone;
  }
}

