/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { itemHeaderCache, itemHeaderCacheKey } from "@/content/popup/cache-instance";
import { runItemHeaderQuery } from "@/lib/queries/itemHeader";

// Smart prefetch.
//
// Goal: in list-view surfaces (saved searches, item lists, reports), after
// the user has been idle for ~3 s, warm the popup's item-header cache for
// the first N visible items so subsequent hovers are instant.
//
// ## Design path chosen: content-script only
//
// We considered two paths:
//
// (a) Pure content-script prefetch (this implementation): the prefetch
//     fires in the same tab as the popup. Wins on simplicity: it reuses
//     `runItemHeaderQuery`, which already goes through the existing
//     `bridge.ts` and the injected SuiteQL runner; it writes to the same
//     `itemHeaderCache` instance the popup reads from. Cancellation is
//     trivial: a single `AbortController` short-circuits new fetches when
//     the surface changes.
//
// (b) Service-worker prefetch: the content script sends a list of item
//     IDs to the SW via chrome.runtime.sendMessage; the SW orchestrates
//     calls. The supposed advantage — surviving content-script reloads —
//     doesn't actually pan out: the SW has no direct access to the page
//     context, so it would have to send messages BACK to the content
//     script to issue each SuiteQL call via the bridge. If the page
//     navigates mid-prefetch, the content script is gone and the SW
//     can't talk to its replacement until the new one finishes its own
//     boot. Worst case for path (a) is a handful of wasted queries that
//     resolve against an unmounted popup — they get GC'd via the
//     `cancelled` flag.
//
// We picked (a). The "page navigates mid-prefetch" risk is low (the user
// just got idle for 3 s) and the failure mode is harmless. If telemetry
// later shows we're losing meaningful warm-up work to navigation churn,
// path (b) is reachable as an additive change.
//
// ## Rate-limit risk (theoretical)
//
// With prefetchN=25 and concurrency=3, a single hover-idle event fires up
// to 25 SuiteQL calls. NetSuite SuiteQL has a documented rate limit of
// ~10 concurrent connections per role; our concurrency cap stays well
// under that, but cumulative usage in a busy session could surface a
// `USAGE_LIMIT_EXCEEDED` error on the first hover after a long browsing
// session. We don't stress-test this here for time reasons, but
// document it as a known theoretical risk: bump
// concurrency below 3 only if real-account telemetry surfaces the
// problem.
//
// ## Race with hover-triggered queries
//
// The popup uses `PersistentCache.fetchSWR`, which checks L1 before
// issuing a fetch. If the prefetch has already written L1, the hover
// returns the cached value synchronously. If the prefetch is in flight,
// the LRU cache's `fetch()` dedup primitive returns the same Promise —
// but `fetchSWR` doesn't use `fetch()`, it uses `read()` + a manual
// fetcher call. That means a concurrent hover that lands during an
// in-flight prefetch will issue a second SuiteQL call. The bridge does
// not dedup at the wire level (one correlation id per call), so this
// is a small double-fetch waste, not a correctness issue. Documented
// here so a future refactor can decide whether to share the L1 inflight
// map between popup and prefetch.

export interface PrefetchOptions {
  // Which account the items belong to. Used to compose the cache key.
  accountId: string;
  // Items to prefetch. Caller is responsible for trimming to
  // `preferences.prefetchN` and removing duplicates / items already
  // visible in cache (we don't dedupe here — the cache layer would just
  // return the cached value on L1, so the cost is one extra L1 lookup).
  itemIds: string[];
  // Concurrency cap. Default is 3.
  // We expose it as a parameter so tests can exercise the slot logic
  // deterministically.
  concurrency: number;
  // Signal honoured between items: when aborted, we stop kicking off
  // new fetches but in-flight fetches run to completion (the bridge
  // doesn't propagate AbortSignal mid-flight; see known-issues.md).
  signal: AbortSignal;
}

export interface PrefetchSummary {
  // Successfully fetched and written to cache.
  ok: number;
  // Threw an error during fetch (any reason except abort).
  failed: number;
  // Skipped because the signal was aborted before the slot opened.
  skipped: number;
}

export interface PrefetchHandle {
  // Resolves once every item has been visited (either fetched, failed,
  // or skipped). Never rejects: per-item failures are folded into the
  // `failed` counter.
  promise: Promise<PrefetchSummary>;
  // Convenience: aborts the underlying signal. Equivalent to the caller
  // aborting the controller they passed in.
  abort(): void;
}

// Internal: the AbortController the caller usually owns isn't accessible
// from a bare AbortSignal, so we let `startPrefetch` ALSO accept the
// controller and expose abort() through the handle. We model this via a
// thin wrapper that derives a child controller from the signal.
function deriveChildController(parent: AbortSignal): AbortController {
  const child = new AbortController();
  if (parent.aborted) {
    child.abort(parent.reason);
    return child;
  }
  const onAbort = (): void => {
    child.abort(parent.reason);
  };
  parent.addEventListener("abort", onAbort, { once: true });
  return child;
}

// Runs the prefetch with a fixed concurrency cap. We implement this as a
// simple "N workers pull from a shared queue" loop rather than batching
// into slices because batches stall on their slowest member — the worker
// model keeps the next-fetch latency tight even when one item is slow.
async function runPrefetch(opts: PrefetchOptions): Promise<PrefetchSummary> {
  const summary: PrefetchSummary = { ok: 0, failed: 0, skipped: 0 };
  const queue = [...opts.itemIds];

  // Drain the queue using N parallel workers, each pulling one item at a
  // time. `queue.shift()` is O(N) for arrays but N <= 25 in our worst case
  // so this stays trivial.
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      // Check the signal before dequeuing so we don't reserve an item we
      // won't process. Anything left in the queue when the signal fires
      // gets counted as skipped.
      if (opts.signal.aborted) return;
      const itemId = queue.shift();
      if (itemId === undefined) return;
      try {
        // Pass the abort signal through. The bridge doesn't currently
        // propagate it mid-flight, so this only short-circuits before
        // the fetch starts — but that's enough to prevent kicking off
        // new fetches once the prefetch is cancelled.
        const value = await runItemHeaderQuery(itemId, opts.signal);
        await itemHeaderCache.write(itemHeaderCacheKey(opts.accountId, itemId), value);
        summary.ok += 1;
      } catch (err) {
        const isAbort = err instanceof DOMException && err.name === "AbortError";
        if (isAbort) {
          // Treat as skipped — the item never had a chance to land in
          // cache because we cancelled before/while it ran.
          summary.skipped += 1;
        } else {
          // Any other failure (timeout, permission, item-not-found) is
          // counted but not propagated. Prefetch is best-effort; the
          // popup will retry on hover and surface the friendly error
          // there if it persists.
          summary.failed += 1;
        }
      }
    }
  }

  const cap = Math.max(1, Math.min(opts.concurrency, opts.itemIds.length));
  const workers: Promise<void>[] = [];
  for (let i = 0; i < cap; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  // Anything still in the queue at this point means a worker exited via
  // the `signal.aborted` short-circuit. Count those as skipped so the
  // summary tallies to `itemIds.length`.
  summary.skipped += queue.length;
  return summary;
}

// Starts a prefetch and returns a handle the caller can use to await
// completion or abort early. Implementation note: the function itself is
// synchronous (returns the handle immediately) so the caller can store the
// handle in a ref before the first worker has a chance to write.
export function startPrefetch(opts: PrefetchOptions): PrefetchHandle {
  const child = deriveChildController(opts.signal);
  const promise = runPrefetch({ ...opts, signal: child.signal });
  return {
    promise,
    abort(): void {
      // Match the bridge's abort reason for consistency with the popup's
      // existing handling.
      if (!child.signal.aborted) {
        child.abort(new DOMException("prefetch-abort", "AbortError"));
      }
    },
  };
}
