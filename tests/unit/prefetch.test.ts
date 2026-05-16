/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { startPrefetch } from "@/content/prefetch";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock the cache module so we can observe writes without involving
// chrome.storage.local. The L1+L2 layer is exercised in
// `persistent-cache.test.ts`; here we only care that prefetch hands the
// query result to the cache under the expected key.
vi.mock("@/content/popup/cache-instance", () => ({
  itemHeaderCache: {
    write: vi.fn(async () => undefined),
  },
  itemHeaderCacheKey: (accountId: string, itemId: string) => `item:${accountId}:${itemId}:header`,
  l1ItemHeader: { delete: vi.fn() },
}));

// Mock the query so we can deterministically choose ok/throw per item.
vi.mock("@/lib/queries/itemHeader", () => ({
  runItemHeaderQuery: vi.fn(),
}));

import { itemHeaderCache } from "@/content/popup/cache-instance";
import { runItemHeaderQuery } from "@/lib/queries/itemHeader";

const cacheWriteMock = (itemHeaderCache as unknown as { write: ReturnType<typeof vi.fn> }).write;
const runItemHeaderQueryMock = runItemHeaderQuery as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  cacheWriteMock.mockReset();
  cacheWriteMock.mockResolvedValue(undefined);
  runItemHeaderQueryMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startPrefetch", () => {
  test("writes every successful fetch into the cache and reports ok counts", async () => {
    runItemHeaderQueryMock.mockImplementation(async (id: string) => ({
      id,
      itemid: `SKU-${id}`,
      qoh: 1,
      qcom: 0,
      qavail: 1,
      qord: 0,
      qbo: 0,
    }));
    const controller = new AbortController();
    const handle = startPrefetch({
      accountId: "ACC",
      itemIds: ["1", "2", "3"],
      concurrency: 3,
      signal: controller.signal,
    });
    const summary = await handle.promise;
    expect(summary).toEqual({ ok: 3, failed: 0, skipped: 0 });
    expect(cacheWriteMock).toHaveBeenCalledTimes(3);
    const keys = cacheWriteMock.mock.calls.map(([key]) => key as string).sort();
    expect(keys).toEqual(["item:ACC:1:header", "item:ACC:2:header", "item:ACC:3:header"]);
  });

  test("counts failures without rejecting the promise", async () => {
    runItemHeaderQueryMock.mockImplementation(async (id: string) => {
      if (id === "2") throw new Error("boom");
      return {
        id,
        itemid: `SKU-${id}`,
        qoh: 0,
        qcom: 0,
        qavail: 0,
        qord: 0,
        qbo: 0,
      };
    });
    const controller = new AbortController();
    const handle = startPrefetch({
      accountId: "ACC",
      itemIds: ["1", "2", "3"],
      concurrency: 1,
      signal: controller.signal,
    });
    const summary = await handle.promise;
    expect(summary).toEqual({ ok: 2, failed: 1, skipped: 0 });
    expect(cacheWriteMock).toHaveBeenCalledTimes(2);
  });

  test("respects the concurrency cap (never more than N in flight)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    runItemHeaderQueryMock.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield so the other workers have a chance to pick up items
      // before we resolve.
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return { id: "x", itemid: "SKU-x", qoh: 0, qcom: 0, qavail: 0, qord: 0, qbo: 0 };
    });
    const controller = new AbortController();
    const handle = startPrefetch({
      accountId: "ACC",
      itemIds: ["1", "2", "3", "4", "5", "6", "7", "8"],
      concurrency: 3,
      signal: controller.signal,
    });
    await handle.promise;
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  test("abort signal stops new fetches but lets in-flight finish", async () => {
    // Use an explicit holder so TypeScript doesn't narrow the type to
    // `never` through the closure-only assignment. The holder shape
    // matches the resolver signature exactly.
    const holders: Array<{ release: () => void }> = [
      { release: () => undefined },
      { release: () => undefined },
      { release: () => undefined },
    ];
    const blockers = holders.map(
      (h) =>
        new Promise<void>((res) => {
          h.release = res;
        }),
    );

    let nextBlockerIdx = 0;
    runItemHeaderQueryMock.mockImplementation(async (id: string) => {
      const blockerIdx = nextBlockerIdx++;
      const blocker = blockers[blockerIdx];
      if (blocker) await blocker;
      return { id, itemid: `SKU-${id}`, qoh: 0, qcom: 0, qavail: 0, qord: 0, qbo: 0 };
    });

    const controller = new AbortController();
    const handle = startPrefetch({
      accountId: "ACC",
      itemIds: ["1", "2", "3", "4", "5"],
      concurrency: 2,
      signal: controller.signal,
    });

    // Two workers are now stuck on items 1 and 2 (waiting on holder[0]/
    // holder[1]). Aborting now should prevent items 3, 4, 5 from ever
    // calling runItemHeaderQuery; items 1 and 2 still finish naturally.
    controller.abort();
    for (const h of holders) h.release();
    const summary = await handle.promise;
    expect(summary.ok).toBe(2);
    expect(summary.skipped).toBe(3);
    expect(summary.failed).toBe(0);
    // Only the two pre-abort fetches were issued.
    expect(runItemHeaderQueryMock).toHaveBeenCalledTimes(2);
  });

  test("handle.abort short-circuits future fetches", async () => {
    const holder: { release: () => void } = { release: () => undefined };
    const blocker = new Promise<void>((res) => {
      holder.release = res;
    });
    let nextBlockerCount = 0;
    runItemHeaderQueryMock.mockImplementation(async (id: string) => {
      if (nextBlockerCount === 0) {
        nextBlockerCount += 1;
        await blocker;
      }
      return { id, itemid: `SKU-${id}`, qoh: 0, qcom: 0, qavail: 0, qord: 0, qbo: 0 };
    });
    const controller = new AbortController();
    const handle = startPrefetch({
      accountId: "ACC",
      itemIds: ["1", "2", "3"],
      concurrency: 1,
      signal: controller.signal,
    });
    handle.abort();
    holder.release();
    const summary = await handle.promise;
    // Only the first item kicked off before the abort.
    expect(runItemHeaderQueryMock).toHaveBeenCalledTimes(1);
    expect(summary.ok).toBe(1);
    expect(summary.skipped).toBe(2);
  });

  test("aborts items that throw AbortError as skipped (not failed)", async () => {
    runItemHeaderQueryMock.mockImplementation(async () => {
      throw new DOMException("aborted", "AbortError");
    });
    const controller = new AbortController();
    const handle = startPrefetch({
      accountId: "ACC",
      itemIds: ["1", "2"],
      concurrency: 1,
      signal: controller.signal,
    });
    const summary = await handle.promise;
    // The query itself reports abort; prefetch buckets that into skipped
    // so failure metrics aren't polluted by user-driven cancellation.
    expect(summary.skipped).toBe(2);
    expect(summary.failed).toBe(0);
  });

  test("empty itemIds returns immediately with all-zero counters", async () => {
    const controller = new AbortController();
    const handle = startPrefetch({
      accountId: "ACC",
      itemIds: [],
      concurrency: 3,
      signal: controller.signal,
    });
    const summary = await handle.promise;
    expect(summary).toEqual({ ok: 0, failed: 0, skipped: 0 });
    expect(runItemHeaderQueryMock).not.toHaveBeenCalled();
    expect(cacheWriteMock).not.toHaveBeenCalled();
  });
});
