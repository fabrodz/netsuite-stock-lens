/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { runSuiteQL } from "@/content/bridge";
import { z } from "zod";

// Per-location inventory breakdown. The aggregate `itemHeader` query already
// returns sums across all locations; this query gives the row-level detail
// the popup uses for the "By location" table.
//
// BUILTIN.DF(iil.location) resolves the location internal id to its display
// name in one round trip. ORDER BY iil.location keeps a stable presentation
// order across calls; the popup is free to re-sort for display.
export const ITEM_LOCATIONS_QUERY = `
  SELECT
    iil.location,
    BUILTIN.DF(iil.location) AS locationname,
    iil.quantityonhand,
    iil.quantitycommitted,
    iil.quantityavailable,
    iil.quantityonorder
  FROM inventoryitemlocations iil
  WHERE iil.item = ?
  ORDER BY iil.location
`;

// SuiteQL returns numeric columns as strings or numbers depending on column
// type and N/query version. We accept both via z.coerce and default to 0 so a
// missing column never crashes the popup. `locationname` can be null when the
// BUILTIN.DF resolver fails (e.g. archived location) — collapse to "" so the
// UI never renders "null".
export const ItemLocationSchema = z.object({
  location: z.union([z.string(), z.number()]).transform(String),
  locationname: z
    .string()
    .nullable()
    .transform((v) => v ?? ""),
  quantityonhand: z.coerce.number().default(0),
  quantitycommitted: z.coerce.number().default(0),
  quantityavailable: z.coerce.number().default(0),
  quantityonorder: z.coerce.number().default(0),
});
export type ItemLocation = z.infer<typeof ItemLocationSchema>;

// Treat any error that mentions the inventoryitemlocations table as MLI-off,
// so the popup can render the rest of the data. We match case-insensitively
// on both "inventoryitemlocations" and "not found" to absorb minor wording
// variations between NetSuite versions.
function looksLikeMliOff(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("inventoryitemlocations") && lower.includes("not found");
}

// Returns the per-location breakdown for one item. Returns [] when MLI is
// disabled (the inventoryitemlocations table doesn't exist) or when the item
// simply has no rows in that table (a non-inventory item, for instance).
// Callers MUST treat an empty array as "no location breakdown available".
export async function runItemLocationsQuery(
  itemId: string | number,
  signal?: AbortSignal,
): Promise<ItemLocation[]> {
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  let rows: ReadonlyArray<Record<string, unknown>>;
  try {
    rows = await runSuiteQL(ITEM_LOCATIONS_QUERY, [itemId], { timeoutMs: 2000 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (looksLikeMliOff(message)) {
      // MLI is off — collapse the error to "no location data" so the rest of
      // the popup still renders. The aggregate itemHeader query handles
      // totals separately and uses NVL() to survive the same scenario.
      return [];
    }
    throw err;
  }

  // Parse each row individually. We intentionally skip malformed rows rather
  // than failing the whole query: one bad location row (e.g. archived location
  // with a null id) shouldn't blank out the entire breakdown for the user.
  const parsed: ItemLocation[] = [];
  for (const row of rows) {
    const result = ItemLocationSchema.safeParse(row);
    if (result.success) {
      parsed.push(result.data);
    } else {
      // Log so we can collect malformed shapes for fixture work; don't throw.
      console.warn("[nsl] itemLocations: skipped malformed row", {
        issues: result.error.issues,
      });
    }
  }
  return parsed;
}
