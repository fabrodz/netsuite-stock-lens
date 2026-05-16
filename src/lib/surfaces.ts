/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { parseAccountId } from "@/lib/accountId";

export type SurfaceKey =
  // --- Transaction surfaces (line context, line-qty badge available) ---
  | "sales-order"
  | "quote"
  | "invoice"
  | "item-fulfillment"
  | "purchase-order"
  | "vendor-bill"
  | "transfer-order"
  | "item-receipt"
  | "inventory-adjustment"
  | "inventory-count"
  // --- List-view surfaces (no per-line context, no line-qty badge) ---
  | "saved-search"
  | "item-list"
  | "report";

interface SurfaceDefinition {
  key: SurfaceKey;
  label: string;
  // Pathname regex (no host). The pattern matches the start of the path so a
  // trailing `?query` is allowed but additional path segments are not.
  pathPattern: RegExp;
}

// Order matters only for documentation: each surface is mutually exclusive
// since their pathnames don't overlap.
const SURFACES: ReadonlyArray<SurfaceDefinition> = [
  // ===== Transaction surfaces =====
  // These surfaces have a per-line context, so the popup can extract a line
  // quantity from the row and render a green/yellow/red status badge.
  {
    key: "sales-order",
    label: "Sales Order",
    pathPattern: /^\/app\/accounting\/transactions\/salesord\.nl(?:$|\?)/,
  },
  {
    key: "quote",
    label: "Quote",
    pathPattern: /^\/app\/accounting\/transactions\/estimate\.nl(?:$|\?)/,
  },
  {
    key: "invoice",
    label: "Invoice",
    pathPattern: /^\/app\/accounting\/transactions\/custinvc\.nl(?:$|\?)/,
  },
  {
    key: "item-fulfillment",
    label: "Item Fulfillment",
    pathPattern: /^\/app\/accounting\/transactions\/itemship\.nl(?:$|\?)/,
  },
  // Purchasing + transfer surfaces. PO and TO use
  // `parseCurrentTransactionId` to exclude themselves from the "Next receipt"
  // list — a PO viewing itself shouldn't claim to be an upcoming receipt.
  {
    key: "purchase-order",
    label: "Purchase Order",
    pathPattern: /^\/app\/accounting\/transactions\/purchord\.nl(?:$|\?)/,
  },
  {
    key: "vendor-bill",
    label: "Vendor Bill",
    pathPattern: /^\/app\/accounting\/transactions\/vendbill\.nl(?:$|\?)/,
  },
  {
    key: "transfer-order",
    label: "Transfer Order",
    pathPattern: /^\/app\/accounting\/transactions\/transord\.nl(?:$|\?)/,
  },
  // Warehouse-flow transactions. These still expose line rows with
  // a quantity column, so the badge behaviour matches the other transaction
  // surfaces.
  {
    key: "item-receipt",
    label: "Item Receipt",
    pathPattern: /^\/app\/accounting\/transactions\/itemrcpt\.nl(?:$|\?)/,
  },
  {
    key: "inventory-adjustment",
    label: "Inventory Adjustment",
    pathPattern: /^\/app\/accounting\/transactions\/invadjst\.nl(?:$|\?)/,
  },
  {
    key: "inventory-count",
    label: "Inventory Count",
    pathPattern: /^\/app\/accounting\/transactions\/invcount\.nl(?:$|\?)/,
  },

  // ===== List-view surfaces =====
  // These pages render many items at once without a per-line "this is the
  // quantity I'm about to commit" semantic. The popup therefore hides the
  // badge (no lineQty to compare against `available`) and the popup behaviour
  // also changes: prefetch is only enabled on list-view surfaces, since
  // hover-driven on-demand fetching produces no useful cache on a long table.
  {
    key: "saved-search",
    label: "Saved Search Results",
    pathPattern: /^\/app\/common\/search\/searchresults\.nl(?:$|\?)/,
  },
  {
    key: "item-list",
    label: "Item List",
    pathPattern: /^\/app\/common\/item\/itemlist\.nl(?:$|\?)/,
  },
  {
    key: "report",
    label: "Report",
    // Reports render both as `report.nl` (run-result) and `reportbuilder.nl`
    // (interactive builder with item drill-through cells). Both expose item
    // anchors that detection's URL strategy already matches.
    pathPattern: /^\/app\/reporting\/(?:report|reportbuilder)\.nl(?:$|\?)/,
  },
];

// Surface keys that correspond to a list-view (saved search, item list,
// report). List-view surfaces lack per-line context: there is no "the user
// is committing this row right now" quantity to compare against, so the
// popup hides its badge and the smart-prefetch path only fires here.
const LIST_VIEW_KEYS: ReadonlySet<SurfaceKey> = new Set<SurfaceKey>([
  "saved-search",
  "item-list",
  "report",
]);

// Returns true if the surface is a list-view (saved search, item list,
// report) where lineQty cannot be inferred from the DOM because there is no
// transaction line context.
export function isListViewSurface(key: SurfaceKey): boolean {
  return LIST_VIEW_KEYS.has(key);
}

// Returns the surface key for a NetSuite transaction URL, or null if the host
// isn't a NetSuite account or the path isn't an allowlisted surface.
export function urlToSurface(url: string | URL): SurfaceKey | null {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return null;
  }
  if (parseAccountId(parsed.hostname) === null) {
    return null;
  }
  // `pathname` is the host-relative path without the query string, which is
  // exactly what our patterns expect.
  const path = parsed.pathname + parsed.search;
  for (const surface of SURFACES) {
    if (surface.pathPattern.test(path)) {
      return surface.key;
    }
  }
  return null;
}

// Parses the NetSuite transaction internal ID from a URL like
// /app/accounting/transactions/purchord.nl?id=12345 or
// /app/accounting/transactions/transord.nl?id=12345&whence=..., returns
// null if no `id` query param is present (e.g. on the empty new-record
// page). We deliberately return the raw string instead of coercing to a
// number: SuiteQL accepts string ids and downstream code can decide whether
// to validate further.
export function parseCurrentTransactionId(url: string | URL): string | null {
  let parsed: URL;
  try {
    parsed = typeof url === "string" ? new URL(url) : url;
  } catch {
    return null;
  }
  const id = parsed.searchParams.get("id");
  if (id === null || id === "") return null;
  return id;
}
