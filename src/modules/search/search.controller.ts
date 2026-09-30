import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { SearchService } from './search.service';
import {
  SearchProductsQueryDto,
  SuggestQueryDto,
} from './dto/search.dto';

/**
 * Both routes are public: the storefront's search box runs before a buyer has
 * an account. They stay cheap because the expensive part (indexing) already
 * happened, and the money in each hit is read from Postgres rather than from
 * the index.
 */
@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get('products')
  @Public()
  @ApiOperation({
    summary: 'Search and filter products',
    description:
      'Returns the usual pagination envelope plus brand, category and price ' +
      'facets. Falls back to a Postgres substring search when Meilisearch is ' +
      'unreachable; the `engine` field reports which one answered.',
  })
  @ApiResponse({ status: 200, description: 'Products with facets' })
  searchProducts(@Query() query: SearchProductsQueryDto) {
    return this.search.searchProducts(query);
  }

  @Get('suggest')
  @Public()
  @ApiOperation({ summary: 'Top product names for a prefix (cached 60s)' })
  suggest(@Query() query: SuggestQueryDto) {
    return this.search.suggest(query.q);
  }
}
