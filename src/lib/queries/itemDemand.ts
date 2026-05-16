/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { runSuiteQL } from "@/content/bridge";
import { z } from "zod";

// Average daily demand over the last 30 days. Sales (CustInvc + CashSale) are
// counted; credit memos are intentionally excluded here because the metric is
// "how fast does this item move out", not net sales. Posted transactions only
// so drafts and pending entries don't skew the trend.
//
// NVL(SUM(...), 0) guards the no-rows case (item with zero sales in 30 days):
// SUM of an empty set is NULL in Oracle and would otherwise return a NULL
// row that confuses the schema parser. Division by 30 is hard-coded — a more
// flexible window length is a future enhancement.
export const ITEM_DEMAND_QUERY = `
  SELECT
    NVL(SUM(tl.quantity), 0) / 30 AS avg_daily_demand
  FROM transactionline tl
  JOIN transaction t ON t.id = tl.transaction
  WHERE tl.item = ?
    AND t.type IN ('CustInvc', 'CashSale')
    AND t.posting = 'T'
    AND t.trandate >= SYSDATE - 30
`;

// Schema for the single-row SUM result. SuiteQL can return numeric columns
// as strings depending on the column type; z.coerce.number() absorbs both
// shapes. Default 0 covers the (theoretically impossible) case where the
// row exists but the column is missing.
export const DemandResultSchema = z.object({
  avg_daily_demand: z.coerce.number().default(0),
});

// Discriminated union over the four UX cases the "Demand" tab renders:
//   ok          — the common case: demand > 0 and stock present.
//   backordered — negative `available` means the warehouse owes more
//                 than it has; the popup tags the row distinctly.
//   no-demand   — no sales in the last 30 days. Cannot compute days of
//                 stock without a denominator.
//   unavailable — query failed with a recoverable permission/table-missing
//                 error. Popup shows "demand data unavailable".
export type DemandResult =
  | { kind: "ok"; avgDailyDemand: number; daysOfStock: number }
  | { kind: "backordered"; avgDailyDemand: number }
  | { kind: "no-demand"; avgDailyDemand: number }
  | { kind: "unavailable"; avgDailyDemand: 0 };

// Same recoverable-error heuristics as the other cross-record queries: permission/
// role errors and "transaction not found" / table-missing collapse to the
// `unavailable` kind so the popup hides the section gracefully.
function looksLikeRecoverableError(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes("permission")) return true;
  if (lower.includes("role")) return true;
  if (lower.includes("insufficient privilege")) return true;
  if (lower.includes("transaction") && lower.includes("not found")) return true;
  return false;
}

// Returns the demand kind for an item given the current `available` quantity
// (sourced from the header query). Edge cases, in evaluation order:
//   1. available < 0           -> backordered (avgDailyDemand may be 0 or >0)
//   2. avgDailyDemand === 0    -> no-demand
//   3. otherwise               -> ok, daysOfStock = round(available / demand)
//
// Permission / table-missing errors short-circuit to { kind: "unavailable" }.
export async function runItemDemandQuery(
  itemId: string | number,
  available: number,
  signal?: AbortSignal,
): Promise<DemandResult> {
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  let rows: ReadonlyArray<Record<string, unknown>>;
  try {
    rows = await runSuiteQL(ITEM_DEMAND_QUERY, [itemId], { timeoutMs: 2000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (looksLikeRecoverableError(message)) {
      return { kind: "unavailable", avgDailyDemand: 0 };
    }
    throw err;
  }

  // The SUM aggregate should always return exactly one row, but defend
  // against an empty response (some SuiteQL frontends drop NULL-only rows).
  let avgDailyDemand = 0;
  if (rows.length > 0) {
    const first = rows[0];
    if (first !== undefined) {
      const parsed = DemandResultSchema.safeParse(first);
      if (parsed.success) {
        avgDailyDemand = parsed.data.avg_daily_demand;
      } else {
        // Treat a malformed shape as "no demand data" rather than throwing —
        // the popup keeps rendering other sections.
        console.warn("[nsl] itemDemand: malformed row, treating as no-demand", {
          issues: parsed.error.issues,
        });
        avgDailyDemand = 0;
      }
    }
  }

  // Backordered takes precedence over no-demand: a negative `available`
  // means the warehouse is in deficit and the popup should warn even if
  // there have been zero sales recently.
  if (available < 0) {
    return { kind: "backordered", avgDailyDemand };
  }
  if (avgDailyDemand === 0) {
    return { kind: "no-demand", avgDailyDemand };
  }
  // available >= 0 and avgDailyDemand > 0: compute days of stock.
  // Math.round keeps the popup compact; a half-day either way is below
  // the precision the user cares about for this metric.
  return {
    kind: "ok",
    avgDailyDemand,
    daysOfStock: Math.round(available / avgDailyDemand),
  };
}
