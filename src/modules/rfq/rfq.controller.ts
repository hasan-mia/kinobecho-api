import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RfqService } from './rfq.service';
import { CreateQuotationDto, CreateRfqDto, ListRfqQueryDto } from './dto/rfq.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { UserRole } from '@prisma/client';

@ApiTags('rfq')
@ApiBearerAuth()
@Controller()
export class RfqController {
  constructor(private readonly rfqService: RfqService) {}

  @Post('rfq')
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({
    summary: 'Post a request for quotation',
    description:
      'Target either a product variant or a category. A request naming a variant ' +
      'can be turned into a wholesale order when a quotation is accepted; a ' +
      'category-level request cannot, because an order line must name a variant.',
  })
  @ApiResponse({ status: 201, description: 'Request created' })
  @ApiResponse({ status: 400, description: 'Missing or conflicting target' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRfqDto,
  ) {
    return this.rfqService.create(user, dto);
  }

  @Get('rfq')
  @ApiOperation({ summary: "The current buyer's own requests, with their quotations" })
  listOwn(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListRfqQueryDto,
  ) {
    return this.rfqService.listOwn(user, query);
  }

  @Get('rfq/open')
  @Roles(UserRole.VENDOR)
  @ApiOperation({
    summary: 'Open requests matching the categories this vendor sells in',
    description:
      'Includes requests filed against a parent category when the vendor stocks ' +
      'a descendant of it. Other vendors quotations are not exposed.',
  })
  listOpen(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListRfqQueryDto,
  ) {
    return this.rfqService.listOpenForVendor(user, query);
  }

  @Post('rfq/:id/quotations')
  @Roles(UserRole.VENDOR)
  @Throttle({ default: { ttl: 900000, limit: 20 } })
  @ApiOperation({
    summary: 'Quote on a request',
    description: 'One quotation per vendor per request; a second is refused.',
  })
  @ApiResponse({ status: 201, description: 'Quotation recorded' })
  @ApiResponse({ status: 409, description: 'Already quoted on this request' })
  createQuotation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateQuotationDto,
  ) {
    return this.rfqService.createQuotation(user, id, dto);
  }

  @Post('quotations/:id/accept')
  @ApiOperation({
    summary: 'Accept a quotation, creating the wholesale order',
    description:
      'The order is priced from the accepted quotation row. No price is accepted ' +
      'from the request. Every other quotation on the request is rejected in the ' +
      'same transaction.',
  })
  @ApiResponse({ status: 201, description: 'Quotation accepted; order created' })
  @ApiResponse({ status: 409, description: 'Quotation no longer available' })
  acceptQuotation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.rfqService.acceptQuotation(user, id);
  }

  @Post('quotations/:id/chat')
  @ApiOperation({
    summary: 'Open the buyer–vendor chat thread behind a quotation',
  })
  @ApiResponse({ status: 201, description: 'Thread created or reused' })
  openChat(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.rfqService.openChat(user, id);
  }
}
