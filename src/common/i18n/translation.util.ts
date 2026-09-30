import { Locale, Prisma } from '@prisma/client';
import { DEFAULT_LOCALE } from './locale.util';

/**
 * A translation row, reduced to what the resolver reads.
 *
 * Structurally compatible with `ProductTranslation`, `CategoryTranslation` and
 * `BrandTranslation` (all have `locale` plus their own fields) so one resolver
 * serves all three without casting at the call site.
 */
export interface TranslationRow {
  locale: Locale;
  name: string;
  description?: string | null;
}

/**
 * Overlays a translation onto the base fields.
 *
 * The base columns are the default language, so the rule is simple: use the
 * translation when one exists for the requested locale, otherwise keep what is
 * already there. A translation that is missing the optional `description` leaves
 * the base description intact rather than blanking it — a partial override must
 * not erase content the translator simply did not touch.
 *
 * Returns the same object shape it was given, with `name`/`description` swapped
 * when a translation applies. Nothing else on the row is touched, so a caller
 * can pass a full Prisma record straight in.
 */
export function applyTranslation<
  T extends { name: string; description?: string | null } | { name: string },
  R extends TranslationRow,
>(
  entity: T,
  translations: readonly R[] | undefined | null,
  locale: Locale,
): T {
  if (locale === DEFAULT_LOCALE || !translations || translations.length === 0) {
    // English is the base language, so its "translation" is the base columns
    // themselves — reading it from the table would be a redundant query that
    // could disagree with them.
    return entity;
  }

  const match = translations.find((t) => t.locale === locale);

  if (!match) {
    return entity;
  }

  const merged: Record<string, unknown> = { ...entity, name: match.name };

  if ('description' in entity && match.description != null) {
    merged['description'] = match.description;
  }

  return merged as T;
}

/**
 * Applies a translation to a list of entities, keyed by their parent id.
 *
 * Built once per request so a 50-product listing resolves its translations with
 * a single `IN` query rather than one per row, and indexed by id so the lookup
 * is a map hit instead of a scan.
 */
export function applyTranslations<
  T extends { id: string; name: string; description?: string | null } | { id: string; name: string },
>(
  entities: readonly T[],
  translations: readonly (TranslationRow & { productId?: string; categoryId?: string; brandId?: string })[],
  locale: Locale,
  parentKey: 'productId' | 'categoryId' | 'brandId',
): T[] {
  if (locale === DEFAULT_LOCALE || !translations || translations.length === 0) {
    return [...entities];
  }

  const byParent = new Map<string, TranslationRow>();

  for (const row of translations) {
    const parentId = row[parentKey];

    if (parentId) {
      byParent.set(parentId, row);
    }
  }

  return entities.map((entity) => {
    const match = byParent.get(entity.id);

    return match ? applyTranslation(entity, [match], locale) : entity;
  });
}

/** The Prisma include that loads every translation, for a listing or detail. */
export const TRANSLATION_INCLUDE = {
  translations: true,
} satisfies Prisma.ProductInclude;

export type ProductWithTranslations = Prisma.ProductGetPayload<{
  include: typeof TRANSLATION_INCLUDE;
}>;
