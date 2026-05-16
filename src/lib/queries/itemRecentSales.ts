/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { runSuiteQL } from "@/content/bridge";
import { z } from "zod";

// Top 5 recent sales lines for one item. We intentionally include three
// transaction types so the "Recent sales" tab covers the full picture of how
// the item leaves inventory:
//   - CustInvc : standard invoice (positive quantity)
//   - CashSale : cash-receipt sale (positive quantity)
//   - CustCred : credit memo / return (negative quantity)
// Including credit memos surfaces returns inline, which is more useful for the
// "did this customer keep what they bought?" intuition than filtering to
// invoices only. v1 is NOT filtered by current customer (decision deferred to
// a future opt-in toggle).
//
// t.posting = 'T' ensures we only see posted transactions (drafts and
// pending-approval entries are excluded so the popup doesn't show data the
// user can't reconcile with the GL).
export const ITEM_RECENT_SALES_QUERY = `
  SELECT
    t.tranid, t.trandate, BUILTIN.DF(t.entity) AS customer,
    tl.quantity, tl.rate, t.type
  FROM transactionline tl
  JOIN transaction t ON t.id = tl.transaction
  WHERE tl.item = ?
    AND t.type IN ('CustInvc', 'CashSale', 'CustCred')
    AND t.posting = 'T'
  ORDER BY t.trandate DESC
  FETCH FIRST 5 ROWS ONLY
`;

// `customer` collapses to "" when BUILTIN.DF can't resolve (deleted customer
// record). `rate` is nullable on a few legacy column shapes; we default to 0
// because the UI displays a price field, never a free-form expression.
// `type` is left as a free string — the UI keys off the three CustInvc/
// CashSale/CustCred values to label rows.
export const RecentSaleSchema = z.object({
  tranid: z.string(),
  trandate: z.string().nullable(),
  customer: z
    .string()
    .nullable()
    .transform((v) => v ?? ""),
  quantity: z.coerce.number(),
  // Accept null (legacy column shape) and coerce strings/numbers via
  // z.coerce. Null collapses to 0 so the UI never renders "null".
  rate: z.coerce
    .number()
    .nullable()
    .transform((v) => v ?? 0),
  // CustInvc | CashSale | CustCred — left as a free string so future
  // transaction types added to the query don't require a schema bump.
  type: z.string(),
});
export type RecentSale = z.infer<typeof RecentSaleSchema>;

// Same recoverable-error heuristics as itemNextReceipt: permission/role
// errors and "transaction table not found" collapse to an empty array so the
// rest of the popup keeps rendering. Anything else re-throws and the popup
// surfaces a friendly error code.
function looksLikeRecoverableError(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes("permission")) return true;
  if (lower.includes("role")) return true;
  if (lower.includes("insufficient privilege")) return true;
  if (lower.includes("transaction") && lower.includes("not found")) return true;
  return false;
}

// Returns up to 5 most recent sales lines for the item. Returns [] when the
// query throws a recoverable permission or table-missing error so the rest
// of the popup can still render. Per-row safe-parse skips malformed rows
// rather than failing the whole section.
export async function runItemRecentSalesQuery(
  itemId: string | number,
  signal?: AbortSignal,
): Promise<RecentSale[]> {
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  let rows: ReadonlyArray<Record<string, unknown>>;
  try {
    rows = await runSuiteQL(ITEM_RECENT_SALES_QUERY, [itemId], { timeoutMs: 2000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (looksLikeRecoverableError(message)) {
      return [];
    }
    throw err;
  }

  const parsed: RecentSale[] = [];
  for (const row of rows) {
    const result = RecentSaleSchema.safeParse(row);
    if (result.success) {
      parsed.push(result.data);
    } else {
      console.warn("[nsl] itemRecentSales: skipped malformed row", {
        issues: result.error.issues,
      });
    }
  }
  return parsed;
}
