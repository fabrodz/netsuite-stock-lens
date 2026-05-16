/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import type { SchemaProbeResult } from "@/lib/schemaProbe";

// Query types we might consider skipping based on schema. Kept as a string
// union (not an enum) so callers can pass the literal at the call site
// without ceremony.
export type AdaptableQueryType =
  | "itemLocations"
  | "itemNextReceipt"
  | "itemRecentSales"
  | "itemDemand";

// Given a (possibly null) probe result and a query intent, returns whether
// the query should be skipped entirely.
//
// Conservative default: when `schema === null` we never skip. We'd rather
// pay one wasted SuiteQL round-trip than hide data because we haven't
// probed yet. Once the probe completes the popup re-renders and the next
// hover uses the real result.
//
// We only refine `itemLocations`: MLI-off accounts always return an
// empty array, so skipping the call saves the round-trip. The other three
// queries don't have a reliable schema-level skip signal — bin
// tracking and lots/serials are about *content* visibility inside the
// existing queries, not gating the queries themselves. A future pass can revisit
// when the demand / recent-sales queries grow optional bin and lot
// columns.
export function shouldSkipQuery(
  schema: SchemaProbeResult | null,
  queryType: AdaptableQueryType,
): boolean {
  if (schema === null) return false;
  if (queryType === "itemLocations" && schema.mliEnabled === false) {
    return true;
  }
  return false;
}
