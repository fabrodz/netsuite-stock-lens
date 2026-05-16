/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { LRUCache } from "@/lib/cache";
import {
  L1_MAX_ENTRIES,
  L1_TTL_MS,
  L2_FRESH_TTL_MS,
  L2_MAX_ENTRIES,
  L2_STALE_TTL_MS,
  PERSISTENT_CACHE_STORAGE_PREFIX,
  PersistentCache,
  type StorageLike,
} from "@/lib/persistent-cache";
import { beforeEach, describe, expect, test, vi } from "vitest";

// Simple in-memory chrome.storage.local stub. We deliberately reimplement
// rather than reuse tests/setup.ts so each persistent-cache test gets its
// own isolated store and we can simulate quota errors.
function makeStorageStub(): {
  storage: StorageLike;
  data: Map<string, unknown>;
  // Allow tests to make `set` reject N times to simulate quota errors.
  failSetTimes: { count: number };
} {
  const data = new Map<string, unknown>();
  const failSetTimes = { count: 0 };
  const storage: StorageLike = {
    async get(keys) {
      const out: Record<string, unknown> = {};
      if (keys === null || keys === undefined) {
        for (const [k, v] of data) out[k] = v;
      } else if (typeof keys === "string") {
        if (data.has(keys)) out[keys] = data.get(keys);
      } else if (Array.isArray(keys)) {
        for (const k of keys) if (data.has(k)) out[k] = data.get(k);
      } else {
        for (const k of Object.keys(keys)) if (data.has(k)) out[k] = data.get(k);
      }
      return out;
    },
    async set(items) {
      if (failSetTimes.count > 0) {
        failSetTimes.count -= 1;
        throw new Error("QUOTA_EXCEEDED");
      }
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    async remove(keys) {
      const ks = Array.isArray(keys) ? keys : [keys];
      for (const k of ks) data.delete(k);
    },
  };
  return { storage, data, failSetTimes };
}

const parseIdentity = (raw: unknown): { v: number } => {
  // Minimal validation: insist on the {v: number} shape so we exercise the
  // "drop unparseable L2 entry" branch.
  if (typeof raw === "object" && raw !== null && "v" in raw) {
    const n = (raw as { v: unknown }).v;
    if (typeof n === "number") return { v: n };
  }
  throw new Error("bad shape");
};

function makeCache(opts?: { now?: () => number; storage?: StorageLike }) {
  const l1 = new LRUCache<{ v: number }>({
    maxEntries: L1_MAX_ENTRIES,
    ttlMs: L1_TTL_MS,
    now: opts?.now,
  });
  return {
    l1,
    cache: new PersistentCache<{ v: number }>({
      namespace: "test",
      parse: parseIdentity,
      l1,
      now: opts?.now,
      storage: opts?.storage,
    }),
  };
}

describe("L2 cache constants", () => {
  test("exports the documented sizes and TTLs", () => {
    expect(L1_MAX_ENTRIES).toBe(200);
    expect(L1_TTL_MS).toBe(60_000);
    expect(L2_MAX_ENTRIES).toBe(500);
    expect(L2_FRESH_TTL_MS).toBe(60_000);
    expect(L2_STALE_TTL_MS).toBe(300_000);
    expect(PERSISTENT_CACHE_STORAGE_PREFIX).toBe("nsl.cache.v2.");
  });
});

describe("PersistentCache.read", () => {
  let now = 0;
  beforeEach(() => {
    now = 0;
  });

  test("returns fresh-l1 when the L1 has the key", async () => {
    const { storage } = makeStorageStub();
    const { l1, cache } = makeCache({ now: () => now, storage });
    l1.set("k", { v: 1 });
    const hit = await cache.read("k");
    expect(hit).toEqual({ value: { v: 1 }, status: "fresh-l1" });
  });

  test("returns fresh-l2 and backfills L1 when L2 has a fresh entry", async () => {
    const { storage, data } = makeStorageStub();
    const { l1, cache } = makeCache({ now: () => now, storage });
    data.set(`${PERSISTENT_CACHE_STORAGE_PREFIX}test:k`, { insertedAt: 0, value: { v: 2 } });
    now = L2_FRESH_TTL_MS - 1; // just within fresh
    const hit = await cache.read("k");
    expect(hit).toEqual({ value: { v: 2 }, status: "fresh-l2" });
    // L1 backfilled — next read uses fresh-l1.
    expect(l1.get("k")).toEqual({ v: 2 });
  });

  test("returns stale-l2 when L2 is past fresh but within stale window", async () => {
    const { storage, data } = makeStorageStub();
    const { cache } = makeCache({ now: () => now, storage });
    data.set(`${PERSISTENT_CACHE_STORAGE_PREFIX}test:k`, { insertedAt: 0, value: { v: 3 } });
    now = L2_FRESH_TTL_MS + 1;
    const hit = await cache.read("k");
    expect(hit).toEqual({ value: { v: 3 }, status: "stale-l2" });
  });

  test("returns null and removes the entry when past the stale window", async () => {
    const { storage, data } = makeStorageStub();
    const { cache } = makeCache({ now: () => now, storage });
    const key = `${PERSISTENT_CACHE_STORAGE_PREFIX}test:k`;
    data.set(key, { insertedAt: 0, value: { v: 4 } });
    now = L2_STALE_TTL_MS + 1;
    const hit = await cache.read("k");
    expect(hit).toBeNull();
    // Opportunistic remove is fire-and-forget; flush microtasks.
    await Promise.resolve();
    expect(data.has(key)).toBe(false);
  });

  test("drops L2 entries that fail the parser", async () => {
    const { storage, data } = makeStorageStub();
    const { cache } = makeCache({ now: () => now, storage });
    const key = `${PERSISTENT_CACHE_STORAGE_PREFIX}test:k`;
    data.set(key, { insertedAt: 0, value: { not_v: "bad" } });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const hit = await cache.read("k");
    expect(hit).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("PersistentCache.write", () => {
  let now = 0;
  beforeEach(() => {
    now = 0;
  });

  test("writes to both layers", async () => {
    const { storage, data } = makeStorageStub();
    const { l1, cache } = makeCache({ now: () => now, storage });
    await cache.write("k", { v: 9 });
    expect(l1.get("k")).toEqual({ v: 9 });
    const stored = data.get(`${PERSISTENT_CACHE_STORAGE_PREFIX}test:k`) as {
      insertedAt: number;
      value: { v: number };
    };
    expect(stored.value).toEqual({ v: 9 });
    expect(stored.insertedAt).toBe(0);
  });

  test("tolerates a quota error (L1 still updates, no throw)", async () => {
    const { storage, failSetTimes } = makeStorageStub();
    failSetTimes.count = 1;
    const { l1, cache } = makeCache({ now: () => now, storage });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(cache.write("k", { v: 1 })).resolves.toBeUndefined();
    expect(l1.get("k")).toEqual({ v: 1 });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("evicts the oldest L2 entries when over the cap", async () => {
    // Build a cache whose effective cap we can verify by overshooting by 2
    // entries. We can't easily change L2_MAX_ENTRIES (constant), but we can
    // demonstrate the eviction logic by stuffing > MAX entries directly,
    // then writing one more and verifying older ones get removed.
    const { storage, data } = makeStorageStub();
    const { cache } = makeCache({ now: () => now, storage });
    // Pre-seed L2_MAX_ENTRIES entries directly so the next cache.write()
    // triggers eviction of the oldest one.
    for (let i = 0; i < L2_MAX_ENTRIES; i += 1) {
      data.set(`${PERSISTENT_CACHE_STORAGE_PREFIX}test:seed${i}`, {
        insertedAt: i,
        value: { v: i },
      });
    }
    now = L2_MAX_ENTRIES + 1;
    await cache.write("new", { v: 999 });
    // seed0 should be the oldest and is dropped; seed1+ remain.
    expect(data.has(`${PERSISTENT_CACHE_STORAGE_PREFIX}test:seed0`)).toBe(false);
    expect(data.has(`${PERSISTENT_CACHE_STORAGE_PREFIX}test:seed1`)).toBe(true);
    expect(data.has(`${PERSISTENT_CACHE_STORAGE_PREFIX}test:new`)).toBe(true);
  });
});

describe("PersistentCache.fetchSWR", () => {
  let now = 0;
  beforeEach(() => {
    now = 0;
  });

  test("cache miss: emits fetching then fresh, returns fetcher value", async () => {
    const { storage } = makeStorageStub();
    const { cache } = makeCache({ now: () => now, storage });
    const calls: Array<["fetching" | string, unknown]> = [];
    const fetcher = vi.fn(async () => ({ v: 42 }));
    const value = await cache.fetchSWR("k", fetcher, (val, status) => {
      calls.push([status, val]);
    });
    expect(value).toEqual({ v: 42 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      ["fetching", null],
      ["fresh", { v: 42 }],
    ]);
  });

  test("fresh hit: emits once, no refetch", async () => {
    const { storage } = makeStorageStub();
    const { l1, cache } = makeCache({ now: () => now, storage });
    l1.set("k", { v: 1 });
    const calls: Array<[string, unknown]> = [];
    const fetcher = vi.fn(async () => ({ v: 99 }));
    const value = await cache.fetchSWR("k", fetcher, (val, status) => {
      calls.push([status, val]);
    });
    expect(value).toEqual({ v: 1 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(calls).toEqual([["fresh-l1", { v: 1 }]]);
  });

  test("stale hit: emits stale immediately then fresh after refetch", async () => {
    const { storage, data } = makeStorageStub();
    const { cache } = makeCache({ now: () => now, storage });
    data.set(`${PERSISTENT_CACHE_STORAGE_PREFIX}test:k`, {
      insertedAt: 0,
      value: { v: 1 },
    });
    now = L2_FRESH_TTL_MS + 1;
    const calls: Array<[string, unknown]> = [];
    const fetcher = vi.fn(async () => ({ v: 7 }));
    const value = await cache.fetchSWR("k", fetcher, (val, status) => {
      calls.push([status, val]);
    });
    expect(value).toEqual({ v: 7 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      ["stale-l2", { v: 1 }],
      ["fresh", { v: 7 }],
    ]);
  });

  test("stale hit with failing refetch returns the stale value", async () => {
    const { storage, data } = makeStorageStub();
    const { cache } = makeCache({ now: () => now, storage });
    data.set(`${PERSISTENT_CACHE_STORAGE_PREFIX}test:k`, {
      insertedAt: 0,
      value: { v: 1 },
    });
    now = L2_FRESH_TTL_MS + 1;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const value = await cache.fetchSWR(
      "k",
      async () => {
        throw new Error("network");
      },
      () => undefined,
    );
    expect(value).toEqual({ v: 1 });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("PersistentCache.pruneExpired", () => {
  let now = 0;
  beforeEach(() => {
    now = 0;
  });

  test("removes entries past the stale window and keeps fresh ones", async () => {
    const { storage, data } = makeStorageStub();
    const { cache } = makeCache({ now: () => now, storage });
    data.set(`${PERSISTENT_CACHE_STORAGE_PREFIX}test:keep`, {
      insertedAt: 0,
      value: { v: 1 },
    });
    data.set(`${PERSISTENT_CACHE_STORAGE_PREFIX}test:drop`, {
      insertedAt: 0,
      value: { v: 2 },
    });
    now = 100; // "keep" still fresh
    // Bump time past the stale window for the second entry by setting its
    // insertedAt artificially in the past relative to `now`.
    data.set(`${PERSISTENT_CACHE_STORAGE_PREFIX}test:drop`, {
      insertedAt: -L2_STALE_TTL_MS - 1,
      value: { v: 2 },
    });
    await cache.pruneExpired();
    expect(data.has(`${PERSISTENT_CACHE_STORAGE_PREFIX}test:keep`)).toBe(true);
    expect(data.has(`${PERSISTENT_CACHE_STORAGE_PREFIX}test:drop`)).toBe(false);
  });

  test("caps deletions at 10 per call", async () => {
    const { storage, data } = makeStorageStub();
    const { cache } = makeCache({ now: () => now, storage });
    for (let i = 0; i < 25; i += 1) {
      data.set(`${PERSISTENT_CACHE_STORAGE_PREFIX}test:e${i}`, {
        insertedAt: -L2_STALE_TTL_MS - 1,
        value: { v: i },
      });
    }
    await cache.pruneExpired();
    // 25 expired, but at most 10 removed per call -> 15 remain.
    const remaining = Array.from(data.keys()).filter((k) =>
      k.startsWith(`${PERSISTENT_CACHE_STORAGE_PREFIX}test:`),
    );
    expect(remaining).toHaveLength(15);
  });
});
