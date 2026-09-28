import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  Body,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserRole, CampaignStatus } from '@prisma/client';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { NotificationService } from './notification.service';
import { PrismaService } from '../../database/prisma.service';
import {
  CreatePromotionCampaignDto,
  PromotionCampaignQueryDto,
} from './dto/notification.dto';

@ApiTags('promotions')
@ApiBearerAuth()
@Controller('promotions')
export class PromotionCampaignController {
  constructor(
    private readonly notificationService: NotificationService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('promotion:manage')
  @ApiOperation({ summary: 'Create a new promotion campaign (DRAFT)' })
  @ApiResponse({ status: 201, description: 'Campaign created' })
  async createCampaign(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePromotionCampaignDto,
  ) {
    return this.prisma.promotionCampaign.create({
      data: {
        title: dto.title,
        subject: dto.subject,
        bodyHtml: dto.bodyHtml,
        audience: dto.audience,
        targetFilter: dto.targetFilter as any,
        scheduledAt: dto.scheduledAt,
        createdById: user.id,
        status: CampaignStatus.DRAFT,
      },
    });
  }

  @Post(':id/send')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('promotion:manage')
  @ApiOperation({ summary: 'Queue a promotion campaign for sending' })
  @ApiResponse({ status: 200, description: 'Campaign queued for sending' })
  async sendCampaign(@Param('id') campaignId: string) {
    return this.notificationService.enqueuePromotionCampaign(campaignId);
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('promotion:manage')
  @ApiOperation({ summary: 'List promotion campaigns' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'List of campaigns' })
  async listCampaigns(@Query() query: PromotionCampaignQueryDto) {
    const page = Number(query.page) || 1;
    const limit = Number(query.limit) || 20;

    const [campaigns, total] = await Promise.all([
      this.prisma.promotionCampaign.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.promotionCampaign.count(),
    ]);

    return {
      items: campaigns,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('promotion:manage')
  @ApiOperation({ summary: 'Get a promotion campaign by ID' })
  @ApiResponse({ status: 200, description: 'Campaign details' })
  async getCampaign(@Param('id') campaignId: string) {
    const campaign = await this.prisma.promotionCampaign.findUnique({
      where: { id: campaignId },
      include: {
        logs: {
          select: { id: true, channel: true, status: true, recipient: true, sentAt: true, error: true },
          take: 100,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }

    return campaign;
  }
}