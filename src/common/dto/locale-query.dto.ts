import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Locale } from '@prisma/client';

/**
 * Query DTO mixin carrying the `?lang=` override.
 *
 * This exists purely so the global `ValidationPipe`, which runs with
 * `forbidNonWhitelisted: true`, does not reject `?lang=bn` with a 422 on
 * every route that renders translated copy. The decorator that actually reads
 * the value lives in `LocaleParam`.
 *
 * `lang` is deliberately typed as a free string rather than an enum. An
 * unsupported tag is not a client error: `resolveLocale` falls through to
 * `Accept-Language` and then to English, so `?lang=fr` on a store that only
 * ships `en`/`bn` renders English instead of failing the request. Validating
 * against the enum here would turn that graceful fallback into a 422.
 */
export class LocaleQueryDto {
  @ApiPropertyOptional({
    enum: Object.values(Locale),
    description:
      'Language override for translated fields. Falls back to Accept-Language, then to English. ' +
      'An unsupported value is ignored rather than rejected.',
    maxLength: 35,
  })
  @IsString()
  @MaxLength(35)
  @IsOptional()
  lang?: string;
}
