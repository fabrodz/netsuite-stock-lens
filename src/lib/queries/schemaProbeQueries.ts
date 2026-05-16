/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Schema probe queries. Each is a one-shot "does this table exist
// and return at least one row?" check. We keep them as plain SQL constants
// (rather than the full `runX/Schema/wrapper` triplet other queries use)
// because the probe doesn't parse rows — it only cares about success vs
// failure vs empty. The wrappers live in `src/lib/schemaProbe.ts`.
//
// `rownum <= 1` keeps the round-trip cheap on accounts with millions of
// rows; we never want a probe to take longer than ~1500 ms.

// MLI: presence of any row in inventoryitemlocations means at least one
// item-location pair is tracked, which is what "MLI enabled" really means.
export const PROBE_MLI = "SELECT 1 AS present FROM inventoryitemlocations WHERE rownum <= 1";

// Bin tracking: any single row in `bin` is enough. The table only exists
// when bin management is enabled at the company level.
export const PROBE_BINS = "SELECT 1 AS present FROM bin WHERE rownum <= 1";

// Lots and serials: `inventorynumber` is the union table that stores both
// lot numbers and serial numbers. Its presence means at least one tracked
// item is in use.
export const PROBE_LOTS = "SELECT 1 AS present FROM inventorynumber WHERE rownum <= 1";
