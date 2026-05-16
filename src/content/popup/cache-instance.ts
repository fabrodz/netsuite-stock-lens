/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { LRUCache } from "@/lib/cache";
import { L1_MAX_ENTRIES, L1_TTL_MS, PersistentCache } from "@/lib/persistent-cache";
import { type ItemHeader, ItemHeaderSchema } from "@/lib/queries/itemHeader";

// Shared singleton cache for the item header.
//
// Why move it out of HoverPopup.tsx?
//
// Previously the cache was a module-scoped instance inside HoverPopup.tsx,
// which worked fine as long as the popup was the only consumer. Smart prefetch
// adds a list-view prefetcher (`src/content/prefetch.ts`) that needs to
// warm the same cache the popup reads from — otherwise hover-after-prefetch
// would re-fetch identical data. Importing HoverPopup just to read its
// internal cache would pull React + the whole popup tree into the prefetch
// module (and into the entrypoint), which is the wrong dependency graph.
//
// This file holds only the cache constructor calls and the dedup primitive
// for the L1 layer. The two consumers (HoverPopup and prefetch) import the
// instances directly. The key format is unchanged so existing
// L2 entries remain compatible.

// L1: in-memory LRU. 200 entries / 60 s TTL.
export const l1ItemHeader = new LRUCache<ItemHeader>({
  maxEntries: L1_MAX_ENTRIES,
  ttlMs: L1_TTL_MS,
});

// L2: chrome.storage.local with stale-while-revalidate. Re-parses on every
// L2 read so a schema change between extension versions doesn't poison
// the popup with mismatched data.
export const itemHeaderCache = new PersistentCache<ItemHeader>({
  namespace: "itemHeader",
  parse: (raw) => ItemHeaderSchema.parse(raw),
  l1: l1ItemHeader,
});

// Centralized key builder. Both the popup and the prefetcher must compute
// the same key, so we keep it next to the cache instance to avoid drift.
export function itemHeaderCacheKey(accountId: string, itemId: string): string {
  return `item:${accountId}:${itemId}:header`;
}
