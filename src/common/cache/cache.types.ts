export const CACHE_MANAGER = Symbol('CACHE_MANAGER');

export interface Cache {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T, ttl?: number): Promise<void>;
  del(key: string | string[]): Promise<void>;
}
