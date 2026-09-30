import { IsIn, IsISO8601, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class VendorAnalyticsQueryDto {
  @ApiPropertyOptional({ example: '2026-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31T23:59:59.999Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ enum: ['day', 'week', 'month'], default: 'day' })
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  groupBy?: 'day' | 'week' | 'month';
}

export class AdminOverviewQueryDto {
  @ApiPropertyOptional({ example: '2026-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31T23:59:59.999Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

/**
 * Resolves an optional from/to pair into a concrete window.
 *
 * Both ends are required together: a start with no end silently means
 * "everything since then", which for a year-over-year report is a query nobody
 * meant to run. Defaulting to the last 30 days keeps a bare request cheap.
 */
export function resolveWindow(
  from?: string,
  to?: string,
): { from: Date; to: Date } {
  if ((from && !to) || (!from && to)) {
    throw new Error('from and to must be supplied together');
  }

  if (!from || !to) {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { from: start, to: end };
  }

  const start = new Date(from);
  const end = new Date(to);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('from and to must be valid ISO-8601 dates');
  }

  if (start > end) {
    throw new Error('from must be before to');
  }

  return { from: start, to: end };
}
