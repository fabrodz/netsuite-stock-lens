/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { runSuiteQL } from "@/content/bridge";
import { z } from "zod";

// Top 3 upcoming purchase order lines for one item. Filters to PurchOrd
// statuses that represent "still expected to be received": A = Pending
// Supervisor Approval, B = Pending Receipt, D = Partially Received,
// E = Pending Billing/Partially Received. Statuses F (Fully Billed/Received),
// G (Closed), and H (Rejected) are excluded.
//
// t.duedate >= TRUNC(SYSDATE) excludes overdue lines; the popup focuses on
// "what's coming next", not "what should have arrived already". If product
// later wants to include overdue receipts, this is the line to relax.
export const ITEM_NEXT_RECEIPT_QUERY = `
  SELECT
    t.tranid, t.trandate, BUILTIN.DF(t.entity) AS vendor,
    tl.quantity, t.duedate, t.id AS trxid
  FROM transactionline tl
  JOIN transaction t ON t.id = tl.transaction
  WHERE tl.item = ?
    AND t.type = 'PurchOrd'
    AND t.status IN ('A','B','D','E')
    AND t.duedate >= TRUNC(SYSDATE)
  ORDER BY t.duedate ASC
  FETCH FIRST 3 ROWS ONLY
`;

// Filtered variant: same query with an extra `AND t.id != ?` filter so the
// "Next receipt" section can exclude the current record when the popup is
// rendered inside a PO or Transfer Order. We keep this as a second exported
// constant (rather than dynamic SQL assembly) so SuiteQL strings remain
// statically grep-able in src/lib/queries/.
export const ITEM_NEXT_RECEIPT_EXCLUDE_QUERY = `
  SELECT
    t.tranid, t.trandate, BUILTIN.DF(t.entity) AS vendor,
    tl.quantity, t.duedate, t.id AS trxid
  FROM transactionline tl
  JOIN transaction t ON t.id = tl.transaction
  WHERE tl.item = ?
    AND t.type = 'PurchOrd'
    AND t.status IN ('A','B','D','E')
    AND t.duedate >= TRUNC(SYSDATE)
    AND t.id != ?
  ORDER BY t.duedate ASC
  FETCH FIRST 3 ROWS ONLY
`;

// Vendor is nullable when BUILTIN.DF can't resolve the entity (rare, but
// possible for deleted vendor records). Collapse to "" so the UI doesn't
// render "null". `quantity` is coerced because SuiteQL may return strings.
export const NextReceiptRowSchema = z.object({
  tranid: z.string(),
  trandate: z.string().nullable(),
  vendor: z
    .string()
    .nullable()
    .transform((v) => v ?? ""),
  quantity: z.coerce.number(),
  duedate: z.string().nullable(),
  trxid: z.union([z.string(), z.number()]).transform(String),
});
export type NextReceiptRow = z.infer<typeof NextReceiptRowSchema>;

// Heuristics for "permission/role denied" and "transaction table unavailable"
// errors that should degrade silently rather than break the popup. Matches
// "permission", "ROLE", "Insufficient privilege" (case-insensitive) for
// permission errors and "transaction" + "not found" for missing-table errors.
function looksLikeRecoverableError(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes("permission")) return true;
  if (lower.includes("role")) return true;
  if (lower.includes("insufficient privilege")) return true;
  if (lower.includes("transaction") && lower.includes("not found")) return true;
  return false;
}

// Base signature: a bare AbortSignal as the second argument.
// An options-object form extends the base call with excludeTrxId + signal. We
// support both shapes via overloads so existing callers compile unchanged.
export interface RunItemNextReceiptOptions {
  // When provided, the query switches to ITEM_NEXT_RECEIPT_EXCLUDE_QUERY and
  // appends the value to the params list. Used by the PO and Transfer Order
  // surfaces (where the popup should not list the record the user is
  // currently viewing).
  excludeTrxId?: string | number;
  signal?: AbortSignal;
}

// Returns up to 3 upcoming PO lines for the item. Returns [] when the query
// throws a recoverable permission or table-missing error so the rest of the
// popup can still render. Re-throws other errors so the popup surfaces a
// friendly fallback.
//
// The second argument accepts either a bare AbortSignal (legacy shape) or
// an options object (extended shape) for backward compatibility.
export async function runItemNextReceiptQuery(
  itemId: string | number,
  signalOrOptions?: AbortSignal | RunItemNextReceiptOptions,
): Promise<NextReceiptRow[]> {
  // Normalize the second-argument variants. AbortSignal exposes an `aborted`
  // property; the options object never has one.
  const options: RunItemNextReceiptOptions =
    signalOrOptions === undefined
      ? {}
      : signalOrOptions instanceof AbortSignal
        ? { signal: signalOrOptions }
        : signalOrOptions;

  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  // Pick the SQL + params shape based on whether the caller asked to
  // exclude a current transaction id. We keep both queries as named
  // constants so callers (and future grep-driven debugging) can see which
  // SQL ran.
  const hasExclude = options.excludeTrxId !== undefined;
  const sql = hasExclude ? ITEM_NEXT_RECEIPT_EXCLUDE_QUERY : ITEM_NEXT_RECEIPT_QUERY;
  const params: ReadonlyArray<string | number> = hasExclude
    ? // biome-ignore lint/style/noNonNullAssertion: guarded by hasExclude
      [itemId, options.excludeTrxId!]
    : [itemId];

  let rows: ReadonlyArray<Record<string, unknown>>;
  try {
    rows = await runSuiteQL(sql, params, { timeoutMs: 2000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (looksLikeRecoverableError(message)) {
      return [];
    }
    throw err;
  }

  // Per-row safe-parse: a single malformed row shouldn't blank out the entire
  // "next receipt" section. Log dropped rows for future fixture work.
  const parsed: NextReceiptRow[] = [];
  for (const row of rows) {
    const result = NextReceiptRowSchema.safeParse(row);
    if (result.success) {
      parsed.push(result.data);
    } else {
      console.warn("[nsl] itemNextReceipt: skipped malformed row", {
        issues: result.error.issues,
      });
    }
  }
  return parsed;
}
