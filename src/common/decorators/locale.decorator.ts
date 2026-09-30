import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Locale } from '@prisma/client';
import { DEFAULT_LOCALE, resolveLocale } from '../i18n/locale.util';

/**
 * Injects the request's resolved locale.
 *
 * Resolution is `?lang=` → `Accept-Language` → `"en"`. It is a parameter
 * decorator rather than a global interceptor because the locale only matters
 * to handlers that render user-facing copy; background jobs, webhooks and
 * admin bulk operations have no request and should never carry one.
 *
 * The value is also stashed on the request so a later service in the same
 * request (a product service calling a translation helper, say) can read it
 * without threading the argument through every signature.
 */
export const LocaleParam = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Locale => {
    const request = ctx.switchToHttp().getRequest();
    const locale = resolveLocale(request.query?.['lang'], request.headers?.['accept-language']);

    request.locale = locale;

    return locale;
  },
);

/** Reads the locale a {@link LocaleParam}-decorated handler resolved. */
export function localeOf(request: unknown): Locale {
  return (request as { locale?: Locale })?.locale ?? DEFAULT_LOCALE;
}
