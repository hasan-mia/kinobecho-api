import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Prisma, TransactionType } from '@prisma/client';
import { PaymentsService } from './payments.service';
import {
  CreateOrderPaymentDto,
  ListPaymentsQueryDto,
  RefundOrderDto,
} from './dto/payment.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { UserRole } from '@prisma/client';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { PrismaService } from '../../database/prisma.service';

@ApiTags('payments')
@ApiBearerAuth()
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Declared before the parameterised routes so `GET /payments/methods` is not
   * shadowed. Public: the storefront needs it before the buyer has a token.
   */
  @Get('methods')
  @Public()
  @ApiOperation({ summary: 'List the payment methods available at checkout' })
  @ApiResponse({ status: 200, description: 'Enabled payment methods' })
  getMethods() {
    return this.paymentsService.getEnabledMethods();
  }

  @Post('order/:orderId')
  @Roles(UserRole.CUSTOMER, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Start a payment for an order' })
  @ApiResponse({ status: 201, description: 'Payment initiated' })
  createPayment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
    @Body() dto: CreateOrderPaymentDto,
  ) {
    return this.paymentsService.createPaymentForOrder(user, orderId, dto.gateway);
  }

  @Get('order/:orderId')
  @ApiOperation({
    summary: 'List the ledger transactions of an order (buyer, vendor or admin)',
  })
  getOrderTransactions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId') orderId: string,
  ) {
    return this.paymentsService.getOrderTransactions(user, orderId);
  }

  @Post('refund')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('payments:refund')
  @ApiOperation({ summary: 'Refund a paid order' })
  refund(
    @CurrentUser() user: AuthenticatedUser,
    @Body() refundOrderDto: RefundOrderDto,
  ) {
    return this.paymentsService.refundOrder(user, {
      orderId: refundOrderDto.orderId,
      amount:
        refundOrderDto.amount !== undefined
          ? new Prisma.Decimal(refundOrderDto.amount)
          : undefined,
      note: refundOrderDto.note,
      gateway: refundOrderDto.gateway,
    });
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('payments:read')
  @ApiOperation({ summary: 'List all payment transactions' })
  async listPayments(@Query() query: ListPaymentsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.TransactionWhereInput = {
      type: TransactionType.PAYMENT,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          order: { select: { id: true, orderNumber: true, status: true } },
        },
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
