/** DI token for the Meilisearch client, so tests can inject a fake. */
export const MEILI_CLIENT = Symbol('MEILI_CLIENT');

/** Queue carrying index synchronisation jobs. */
export const SEARCH_INDEX_QUEUE = 'search-index';

export type SearchJob =
  | { type: 'upsert'; productId: string }
  | { type: 'delete'; productId: string }
  | { type: 'reindex' };
