/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { LRUCache, LRU_MAX_ENTRIES, LRU_TTL_MS } from "@/lib/cache";
import { describe, expect, test, vi } from "vitest";

describe("cache constants", () => {
  test("exports the documented defaults", () => {
    expect(LRU_MAX_ENTRIES).toBe(200);
    expect(LRU_TTL_MS).toBe(60_000);
  });
});

describe("LRUCache eviction", () => {
  test("evicts the least recently used key when size exceeds max", () => {
    const cache = new LRUCache<number>({ maxEntries: 2, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3); // evicts "a"
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  test("bumps recency on get so a fresh write evicts the truly oldest", () => {
    const cache = new LRUCache<number>({ maxEntries: 2, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    // Touch "a" so "b" becomes the oldest.
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  test("re-setting an existing key updates value without changing eviction headroom", () => {
    const cache = new LRUCache<number>({ maxEntries: 2, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 99); // overwrite, no eviction
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBe(99);
    expect(cache.get("b")).toBe(2);
  });
});

describe("LRUCache TTL", () => {
  test("returns undefined and removes expired entries on get", () => {
    let now = 1_000;
    const cache = new LRUCache<string>({
      maxEntries: 10,
      ttlMs: 500,
      now: () => now,
    });
    cache.set("k", "v");
    expect(cache.get("k")).toBe("v");
    now += 600;
    expect(cache.get("k")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  test("does not expire entries before the TTL elapses", () => {
    let now = 0;
    const cache = new LRUCache<string>({ maxEntries: 10, ttlMs: 1000, now: () => now });
    cache.set("k", "v");
    now = 999;
    expect(cache.get("k")).toBe("v");
  });
});

describe("LRUCache manual operations", () => {
  test("delete removes a key and returns true", () => {
    const cache = new LRUCache<number>({ maxEntries: 10, ttlMs: 60_000 });
    cache.set("a", 1);
    expect(cache.delete("a")).toBe(true);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.delete("a")).toBe(false);
  });

  test("clear empties the cache and in-flight map", () => {
    const cache = new LRUCache<number>({ maxEntries: 10, ttlMs: 60_000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("LRUCache.fetch dedup", () => {
  test("returns the same Promise for concurrent fetches with the same key", async () => {
    const cache = new LRUCache<number>({ maxEntries: 10, ttlMs: 60_000 });
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      // Defer resolution so both callers register before the fetch settles.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 42;
    });

    const p1 = cache.fetch("key", fetcher);
    const p2 = cache.fetch("key", fetcher);
    expect(p1).toBe(p2);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(42);
    expect(r2).toBe(42);
    expect(calls).toBe(1);
  });

  test("caches the value on fetch resolution", async () => {
    const cache = new LRUCache<number>({ maxEntries: 10, ttlMs: 60_000 });
    const fetcher = vi.fn(async () => 7);
    await cache.fetch("key", fetcher);
    expect(cache.get("key")).toBe(7);

    // A second call must come from the cache, not the fetcher.
    await cache.fetch("key", fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  test("does not cache when fetcher rejects, and a fresh call retries", async () => {
    const cache = new LRUCache<number>({ maxEntries: 10, ttlMs: 60_000 });
    const fetcher = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(99);

    await expect(cache.fetch("key", fetcher)).rejects.toThrow("boom");
    expect(cache.get("key")).toBeUndefined();

    const value = await cache.fetch("key", fetcher);
    expect(value).toBe(99);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test("returns cached value without invoking fetcher when entry is fresh", async () => {
    const cache = new LRUCache<number>({ maxEntries: 10, ttlMs: 60_000 });
    cache.set("key", 10);
    const fetcher = vi.fn(async () => 99);
    const value = await cache.fetch("key", fetcher);
    expect(value).toBe(10);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
