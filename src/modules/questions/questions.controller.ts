import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../common/guards/roles.guard';
import { QuestionsService } from './questions.service';
import {
  CreateAnswerDto,
  CreateQuestionDto,
  ListQuestionsQueryDto,
  ModerateQuestionDto,
} from './dto/question.dto';

/**
 * Five questions an hour per user, not per IP: a shopper behind a shared
 * connection, or a family on one NAT, must not lock each other out of asking
 * whether a charger fits. Rate limiting here is about abuse (a script posting
 * thousands of questions), and `@Throttle`'s default tracker already keys on
 * the authenticated user.
 */
const ASK_THROTTLE = { default: { ttl: 3_600_000, limit: 5 } };

@ApiTags('questions')
@Controller()
export class QuestionsController {
  constructor(private readonly questions: QuestionsService) {}

  @Post('products/:productId/questions')
  @ApiBearerAuth()
  @Roles(UserRole.CUSTOMER)
  @Throttle(ASK_THROTTLE)
  @ApiOperation({
    summary: 'Ask a question about a product',
    description: 'Rate limited to 5 per hour. The question is published only once approved.',
  })
  @ApiResponse({ status: 201, description: 'Question created as PENDING' })
  ask(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: CreateQuestionDto,
  ) {
    return this.questions.ask(user, productId, dto);
  }

  @Get('products/:productId/questions')
  @Public()
  @ApiOperation({ summary: 'Approved questions for a product, with answers' })
  listForProduct(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Query() query: ListQuestionsQueryDto,
  ) {
    return this.questions.listForProduct(productId, query);
  }

  @Get('questions/mine')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'The current buyer\'s questions, including pending ones',
  })
  listMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListQuestionsQueryDto,
  ) {
    return this.questions.listMine(user, query);
  }

  @Post('questions/:id/answers')
  @ApiBearerAuth()
  @Roles(UserRole.VENDOR, UserRole.VENDOR_STAFF, UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Answer a question',
    description:
      'Only the vendor who sells the product, or an admin. Answering also ' +
      'publishes a pending question, since the vendor has vouched for it.',
  })
  answer(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAnswerDto,
  ) {
    return this.questions.answer(user, id, dto);
  }

  @Patch('questions/:id/moderate')
  @ApiBearerAuth()
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @RequirePermissions('qa:moderate')
  @ApiOperation({ summary: 'Approve or reject a question (reason required to reject)' })
  moderate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModerateQuestionDto,
  ) {
    return this.questions.moderate(user, id, dto);
  }
}
