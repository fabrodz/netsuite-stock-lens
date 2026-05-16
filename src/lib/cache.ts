/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Defaults exported so the content script can construct the same
// shared cache instance without duplicating magic numbers.
export const LRU_MAX_ENTRIES = 200;
export const LRU_TTL_MS = 60_000;

export interface CacheEntry<T> {
  value: T;
  insertedAt: number;
}

export interface LRUCacheOptions {
  maxEntries: number;
  ttlMs: number;
  // Injectable clock for deterministic tests.
  now?: () => number;
}

/**
 * In-memory LRU with TTL and in-flight dedup.
 *
 * The consumer constructs the cache key. Keys follow the format
 * `item:${accountId}:${itemId}:v1` — including a version suffix so a
 * future schema change (multi-location, etc.) doesn't collide with
 * stale entries.
 *
 * Recency is tracked by exploiting JavaScript Map's insertion-order
 * iteration: on `get` we delete + re-set the entry so it becomes the most
 * recent in the iteration order. Eviction deletes the first key returned by
 * the iterator, which is the least recently touched entry.
 */
export class LRUCache<T> {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(opts: LRUCacheOptions) {
    this.maxEntries = opts.maxEntries;
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.insertedAt >= this.ttlMs) {
      // Expired entries are removed on read so the cache doesn't keep
      // stale memory around until eviction.
      this.entries.delete(key);
      return undefined;
    }
    // Bump recency: delete + re-set moves the entry to the end of the
    // Map's insertion order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, { value, insertedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      // Map iteration order is insertion order: the first key is the
      // oldest / least recently used.
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  // Returns the same Promise for concurrent fetches of the same key. On
  // resolution the value is stored. On rejection the in-flight entry is
  // removed so the next call retries; the cache is NOT polluted with the
  // error.
  fetch(key: string, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }
    const promise = (async () => {
      try {
        const value = await fetcher();
        this.set(key, value);
        return value;
      } finally {
        // Always clear in-flight, whether the fetch succeeded or threw.
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }
}
