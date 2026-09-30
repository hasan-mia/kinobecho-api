import { Locale } from '@prisma/client';

/**
 * The base language every response falls back to.
 *
 * Base columns (`Product.name`, `Category.name`, `Brand.name`) hold this
 * language, which is why it is a constant rather than another translation row:
 * a translation is an *override*, never a replacement.
 */
export const DEFAULT_LOCALE = Locale.en;

export const SUPPORTED_LOCALES: readonly Locale[] = [Locale.en, Locale.bn];

const SUPPORTED = new Set<string>(SUPPORTED_LOCALES);

/**
 * Normalises one locale token to a supported value, or null.
 *
 * Accepts the regional variants browsers actually send — `bn-BD`, `en-GB`,
 * `EN-us` — and takes the primary subtag, because the difference between
 * `bn-BD` and `bn-IN` is not a translation this store actually carries. A value
 * we do not carry is null rather than a silent default, so the caller can fall
 * back explicitly and log it.
 */
export function normalizeLocale(raw: string | undefined | null): Locale | null {
  if (!raw) {
    return null;
  }

  const primary = raw.trim().toLowerCase().split(/[-_]/)[0] ?? '';

  return SUPPORTED.has(primary) ? (primary as Locale) : null;
}

/**
 * Parses an `Accept-Language` header into the best supported locale.
 *
 * Quality values are honoured: a browser sending `fr;q=0.9, bn;q=0.8` wants
 * Bengali *far* more than French, and picking by header order would be wrong
 * whenever a client lists an unsupported language first. Entries with q=0 are an
 * explicit refusal and are skipped.
 */
export function parseAcceptLanguage(
  header: string | undefined | null,
): Locale | null {
  if (!header) {
    return null;
  }

  const candidates = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.trim().slice(2)) : 1;

      return { tag: (tag ?? '').trim(), q: Number.isFinite(q) ? q : 0 };
    })
    // Stable sort so equal q values keep the client's stated preference order
    // rather than whatever the comparator's tie-break happens to be.
    .sort((a, b) => b.q - a.q);

  for (const candidate of candidates) {
    if (candidate.q <= 0) {
      continue;
    }

    const locale = normalizeLocale(candidate.tag);

    if (locale) {
      return locale;
    }
  }

  return null;
}

/**
 * Resolves the request locale.
 *
 * `?lang=` wins over `Accept-Language`: an explicit query parameter is a
 * deliberate choice, whereas the header is whatever the browser or a proxy
 * decided. An unsupported `?lang=` is ignored rather than honoured, because
 * echoing a locale the store cannot render would return content the caller
 * did not ask for and cannot read.
 */
export function resolveLocale(query: unknown, header: unknown): Locale {
  const fromQuery =
    typeof query === 'string' ? normalizeLocale(query) : null;

  if (fromQuery) {
    return fromQuery;
  }

  const fromHeader = parseAcceptLanguage(
    typeof header === 'string' ? header : null,
  );

  return fromHeader ?? DEFAULT_LOCALE;
}
