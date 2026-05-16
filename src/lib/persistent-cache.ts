/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import type { LRUCache } from "@/lib/cache";

// Cache sizing. These are exported so callers don't duplicate magic
// numbers and so tests can assert against the public contract.
export const L1_MAX_ENTRIES = 200;
export const L1_TTL_MS = 60_000;
export const L2_MAX_ENTRIES = 500;
export const L2_FRESH_TTL_MS = 60_000;
export const L2_STALE_TTL_MS = 300_000;

// Single prefix for all persistent cache keys, bumped in the version segment
// when the on-disk shape changes (e.g. `v3.` if we ever add encryption).
export const PERSISTENT_CACHE_STORAGE_PREFIX = "nsl.cache.v2.";

export interface CacheReadResult<T> {
  value: T;
  // - "fresh"     : returned only from fetchSWR after a successful refetch
  //                 (we don't know which layer the freshly-written value will
  //                 be read from on the next call). Synthetic.
  // - "fresh-l1"  : L1 hit within fresh TTL.
  // - "fresh-l2"  : L1 miss, L2 hit within fresh TTL (L2 -> L1 backfill).
  // - "stale-l1"  : L1 hit but past the L1 TTL but within the L2 stale window
  //                 (the LRU itself expired the entry, but L2 may still hold
  //                 it — currently a dead state, kept for callers that may
  //                 emit a stale L1 if we ever loosen L1 TTL).
  // - "stale-l2"  : L1 miss, L2 hit past fresh TTL but within the stale window.
  status: "fresh" | "stale-l1" | "stale-l2" | "fresh-l1" | "fresh-l2";
}

// L2 storage envelope. The value is whatever the caller stored; we don't
// constrain its shape because the caller owns parse/validation.
interface StoredEntry {
  insertedAt: number;
  value: unknown;
}

// Minimal subset of chrome.storage.LocalStorageArea we use. Defined here so
// tests can supply a mock and so the runtime type stays narrow.
export interface StorageLike {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface PersistentCacheOptions<T> {
  // Stable namespace, used as the second segment of the storage key. Example:
  // namespace="itemHeader" -> key "nsl.cache.v2.itemHeader:<key>".
  namespace: string;
  // Validates and coerces L2 reads. Throws on bad data; we catch and drop.
  parse: (raw: unknown) => T;
  // L1 instance (caller owns lifetime).
  l1: LRUCache<T>;
  // Test-only injection points.
  now?: () => number;
  storage?: StorageLike;
}

function defaultStorage(): StorageLike | null {
  // Guard for unit tests that don't stub chrome.storage.local. Returning null
  // here means the cache silently degrades to L1-only.
  if (typeof chrome !== "undefined" && chrome?.storage?.local) {
    return chrome.storage.local as unknown as StorageLike;
  }
  return null;
}

/**
 * Two-layer cache with stale-while-revalidate.
 *
 * L1 is an in-memory LRU (200 entries, 60 s TTL). L2 is `chrome.storage.local`
 * (500 entries, 60 s fresh TTL, up to 300 s stale-while-revalidate).
 *
 * Read order: L1 -> L2 -> fetch. On fetch success: write both layers.
 *
 * ## Eviction strategy
 *
 * Trade-off: on every `write`, we list every key under the prefix via
 * a single `storage.get(null)` call and prune the oldest entries beyond the
 * cap. This is O(N) per write where N is the count of cached keys (up to
 * `L2_MAX_ENTRIES`). The alternative — maintaining an index key with the
 * recent keys ordered by `insertedAt` — adds invariants we'd have to keep in
 * sync across write/evict/prune. With N <= 500 and writes happening at human
 * hover speed (single-digit writes per minute), the simpler approach is
 * cheap enough and easier to reason about. Revisit if the cap is raised
 * meaningfully.
 *
 * ## Quota handling
 *
 * `chrome.storage.local` has a 10 MB quota by default. If `set` throws
 * (quota exceeded), we log and continue — the L1 write already happened so
 * the in-tab experience is unaffected. We never propagate a write failure to
 * the caller; the popup must keep rendering.
 */
export class PersistentCache<T> {
  private readonly namespace: string;
  private readonly parse: (raw: unknown) => T;
  private readonly l1: LRUCache<T>;
  private readonly now: () => number;
  private readonly storage: StorageLike | null;
  private prunedOnce = false;

  constructor(opts: PersistentCacheOptions<T>) {
    this.namespace = opts.namespace;
    this.parse = opts.parse;
    this.l1 = opts.l1;
    this.now = opts.now ?? Date.now;
    this.storage = opts.storage ?? defaultStorage();
  }

  private storageKey(key: string): string {
    return `${PERSISTENT_CACHE_STORAGE_PREFIX}${this.namespace}:${key}`;
  }

  // Returns true when the stored entry is still within the stale window.
  // Past the stale window the entry is treated as gone.
  private isWithinStaleWindow(insertedAt: number): boolean {
    return this.now() - insertedAt < L2_STALE_TTL_MS;
  }

  private isFresh(insertedAt: number): boolean {
    return this.now() - insertedAt < L2_FRESH_TTL_MS;
  }

  async read(key: string): Promise<CacheReadResult<T> | null> {
    // Lazy GC: prune expired entries on the first read of this cache
    // instance's lifetime. Bounded to ~10 keys per call so we don't stall the
    // hover path.
    if (!this.prunedOnce) {
      this.prunedOnce = true;
      // Fire-and-forget: prune must never block a read.
      void this.pruneExpired().catch((err) => {
        console.warn("[nsl] persistent-cache: pruneExpired failed", err);
      });
    }

    // L1: in-memory LRU. Its own TTL governs freshness here — if `get`
    // returns a value, it's fresh.
    const l1Value = this.l1.get(key);
    if (l1Value !== undefined) {
      return { value: l1Value, status: "fresh-l1" };
    }

    // L2: chrome.storage.local.
    if (!this.storage) return null;

    const storageKey = this.storageKey(key);
    let stored: StoredEntry | null;
    try {
      const raw = await this.storage.get(storageKey);
      stored = this.coerceStored(raw[storageKey]);
    } catch (err) {
      console.warn("[nsl] persistent-cache: storage.get failed", err);
      return null;
    }
    if (!stored) return null;

    // Validate the stored value through the caller-supplied parser. If parse
    // fails, drop the entry so we don't return stale-but-invalid data.
    let parsed: T;
    try {
      parsed = this.parse(stored.value);
    } catch (err) {
      console.warn("[nsl] persistent-cache: dropping unparseable L2 entry", {
        key,
        err,
      });
      // Best-effort remove; ignore errors.
      void this.storage.remove(storageKey).catch(() => undefined);
      return null;
    }

    if (this.isFresh(stored.insertedAt)) {
      // Backfill L1 so the next read in this tab is hot.
      this.l1.set(key, parsed);
      return { value: parsed, status: "fresh-l2" };
    }
    if (this.isWithinStaleWindow(stored.insertedAt)) {
      return { value: parsed, status: "stale-l2" };
    }
    // Past the stale window — treat as missing. Drop opportunistically.
    void this.storage.remove(storageKey).catch(() => undefined);
    return null;
  }

  async write(key: string, value: T): Promise<void> {
    // Always update L1 first so the in-tab experience is hot regardless of
    // storage outcome.
    this.l1.set(key, value);
    if (!this.storage) return;

    const envelope: StoredEntry = { insertedAt: this.now(), value };
    const storageKey = this.storageKey(key);
    try {
      await this.storage.set({ [storageKey]: envelope });
    } catch (err) {
      // Quota / serialization errors must not break the caller.
      console.warn("[nsl] persistent-cache: storage.set failed", err);
      return;
    }
    // Eviction sweep: keep at most L2_MAX_ENTRIES entries per cache instance.
    // We run it after the successful write so a quota error doesn't trigger
    // an unnecessary scan.
    try {
      await this.evictBeyondMax();
    } catch (err) {
      console.warn("[nsl] persistent-cache: evictBeyondMax failed", err);
    }
  }

  async fetchSWR(
    key: string,
    fetcher: () => Promise<T>,
    onValue: (value: T | null, status: "fetching" | CacheReadResult<T>["status"]) => void,
  ): Promise<T> {
    const hit = await this.read(key);

    if (hit && (hit.status === "fresh-l1" || hit.status === "fresh-l2")) {
      // Fresh hit: emit once, no refetch.
      onValue(hit.value, hit.status);
      return hit.value;
    }

    if (hit && (hit.status === "stale-l1" || hit.status === "stale-l2")) {
      // Stale hit: render immediately, refresh in the background. The fresh
      // value replaces the stale one when it arrives. We don't propagate
      // background-refetch errors to the caller — the user already saw stale
      // data and a transient network blip shouldn't downgrade that to an
      // error state. The error is logged for debugging.
      onValue(hit.value, hit.status);
      try {
        const fresh = await fetcher();
        await this.write(key, fresh);
        onValue(fresh, "fresh");
        return fresh;
      } catch (err) {
        console.warn("[nsl] persistent-cache: background refresh failed", err);
        return hit.value;
      }
    }

    // Cache miss: signal "fetching" so the popup can show a loading
    // skeleton, then await the fetch and emit the fresh value.
    onValue(null, "fetching");
    const fresh = await fetcher();
    await this.write(key, fresh);
    onValue(fresh, "fresh");
    return fresh;
  }

  // Public so callers can run an explicit prune on idle (e.g. service
  // worker startup). Bounded to ~10 deletions per call to keep the
  // storage.get() result small in practice; users with under 500 keys
  // will see at most a handful of expired entries at any time.
  async pruneExpired(): Promise<void> {
    if (!this.storage) return;
    const all = await this.listOwnEntries();
    const expired: string[] = [];
    for (const [k, entry] of all) {
      if (!this.isWithinStaleWindow(entry.insertedAt)) {
        expired.push(k);
        if (expired.length >= 10) break;
      }
    }
    if (expired.length > 0) {
      await this.storage.remove(expired);
    }
  }

  // Lists entries owned by this cache instance (namespace-scoped) and
  // their insertedAt timestamps. We rely on `storage.get(null)` returning
  // every key; the prefix filter keeps cross-namespace data out of our
  // bookkeeping.
  private async listOwnEntries(): Promise<Array<[string, StoredEntry]>> {
    if (!this.storage) return [];
    const all = await this.storage.get(null);
    const namespacePrefix = `${PERSISTENT_CACHE_STORAGE_PREFIX}${this.namespace}:`;
    const out: Array<[string, StoredEntry]> = [];
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(namespacePrefix)) continue;
      const entry = this.coerceStored(v);
      if (entry) out.push([k, entry]);
    }
    return out;
  }

  private async evictBeyondMax(): Promise<void> {
    if (!this.storage) return;
    const entries = await this.listOwnEntries();
    if (entries.length <= L2_MAX_ENTRIES) return;
    // Oldest insertedAt first; drop the difference.
    entries.sort((a, b) => a[1].insertedAt - b[1].insertedAt);
    const toDrop = entries.slice(0, entries.length - L2_MAX_ENTRIES).map(([k]) => k);
    if (toDrop.length > 0) {
      await this.storage.remove(toDrop);
    }
  }

  // Defensive coercion: anything stored by an older version of the cache or
  // by a different namespace may not match StoredEntry. Return null when the
  // shape doesn't match so we can drop the entry rather than crashing.
  private coerceStored(raw: unknown): StoredEntry | null {
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as { insertedAt?: unknown; value?: unknown };
    if (typeof obj.insertedAt !== "number") return null;
    if (!("value" in obj)) return null;
    return { insertedAt: obj.insertedAt, value: obj.value };
  }
}
