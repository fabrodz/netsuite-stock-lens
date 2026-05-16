/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { runSuiteQL } from "@/content/bridge";
import { z } from "zod";

// Primary query: aggregate inventory totals for one item across all
// locations. NVL() guards against NULL columns on accounts where MLI is on
// but a particular location row has unset quantities.
export const ITEM_HEADER_QUERY = `
  SELECT
    i.id, i.itemid, i.displayname, i.itemtype,
    SUM(NVL(iil.quantityonhand, 0)) AS qoh,
    SUM(NVL(iil.quantitycommitted, 0)) AS qcom,
    SUM(NVL(iil.quantityavailable, 0)) AS qavail,
    SUM(NVL(iil.quantityonorder, 0)) AS qord,
    SUM(NVL(iil.quantitybackordered, 0)) AS qbo
  FROM item i
  LEFT JOIN inventoryitemlocations iil ON iil.item = i.id
  WHERE i.id = ?
  GROUP BY i.id, i.itemid, i.displayname, i.itemtype
`;

// Fallback query for accounts where the join table is renamed or for
// non-inventory items that don't have a row in inventoryitemlocations. The
// returned row has no totals; the Zod schema fills zeros via .default(0).
export const ITEM_HEADER_FALLBACK_QUERY = `
  SELECT i.id, i.itemid, i.displayname, i.itemtype
  FROM item i
  WHERE i.id = ?
`;

export const ItemHeaderSchema = z.object({
  // SuiteQL returns id as string or number depending on the column type.
  id: z.union([z.string(), z.number()]).transform(String),
  itemid: z.string(),
  displayname: z.string().nullable().optional(),
  itemtype: z.string().nullable().optional(),
  qoh: z.coerce.number().default(0),
  qcom: z.coerce.number().default(0),
  qavail: z.coerce.number().default(0),
  qord: z.coerce.number().default(0),
  qbo: z.coerce.number().default(0),
});

export type ItemHeader = z.infer<typeof ItemHeaderSchema>;

// The bridge does not yet support AbortSignal-driven cancellation: signals
// only short-circuit *before* we hit the bridge. Once a request is in
// flight the bridge's 3000 ms timeout is the only stop condition. Document
// here so callers don't expect mid-flight abort behaviour.
export async function runItemHeaderQuery(
  itemId: string | number,
  signal?: AbortSignal,
): Promise<ItemHeader> {
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  const primaryRows = await runSuiteQL(ITEM_HEADER_QUERY, [itemId], { timeoutMs: 3000 });

  if (primaryRows.length > 0) {
    const first = primaryRows[0];
    if (first !== undefined) {
      return ItemHeaderSchema.parse(first);
    }
  }

  // The primary query returned no rows at all — could be a non-inventory
  // item or an account with a renamed join table. Retry against the item
  // table alone; the schema fills zeros for the missing totals.
  const fallbackRows = await runSuiteQL(ITEM_HEADER_FALLBACK_QUERY, [itemId], { timeoutMs: 3000 });
  if (fallbackRows.length === 0) {
    throw new Error("item-not-found");
  }
  const first = fallbackRows[0];
  if (first === undefined) {
    throw new Error("item-not-found");
  }
  return ItemHeaderSchema.parse(first);
}
