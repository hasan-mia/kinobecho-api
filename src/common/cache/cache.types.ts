export const CACHE_MANAGER = Symbol('CACHE_MANAGER');

export interface Cache {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T, ttl?: number): Promise<void>;
  del(key: string | string[]): Promise<void>;
  /**
   * Atomically increments a counter and returns the new value, applying `ttl` to
   * the key only when the counter is created.
   *
   * Used for rate limiting, where a non-atomic read-then-write would let two
   * concurrent requests both observe "under the limit" and both pass.
   */
  incrWithTtl(key: string, ttl?: number): Promise<number>;
}
