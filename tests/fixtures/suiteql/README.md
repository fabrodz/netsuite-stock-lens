# SuiteQL fixtures

Canonical mocked SuiteQL responses used by the unit tests and the popup
integration tests. Each fixture is the **parsed/coerced shape** the
typed wrapper functions return — not the raw row format that
`runSuiteQL` produces.

These fixtures are mocked from documented SuiteQL semantics, not
extracted from a real production account.

## File index

| File | Shape | Notes |
|---|---|---|
| `itemHeader.mli-on.json` | `ItemHeader` | Inventory item with MLI on. qoh=120, qcom=20, qavail=95, qord=50, qbo=5. |
| `itemHeader.mli-off.json` | `ItemHeader` | Inventory item but MLI disabled — `runItemHeaderQuery` aggregates totals from the item alone. qoh=80, qcom=10, qavail=70, qord=0. |
| `itemHeader.non-inventory.json` | `ItemHeader` | Service item. itemtype="Service", all quantity columns 0. The popup renders "No inventory tracked" for this shape. |
| `itemHeader.zero-stock.json` | `ItemHeader` | Inventory item with no current stock. qoh=0, qcom=0, qavail=0, qord=0. Distinguishes "tracked but empty" from "not tracked at all". |
| `itemLocations.mli-on.json` | `ItemLocation[]` | Three locations: Main Warehouse, East Coast, West Coast. |
| `itemLocations.mli-off.json` | `ItemLocation[]` | Empty array — `runItemLocationsQuery` returns `[]` when the table is unavailable. |
| `itemNextReceipt.three-pos.json` | `NextReceiptRow[]` | Three incoming POs, vendors Acme/Beta/Acme, due dates ascending. |
| `itemNextReceipt.none.json` | `NextReceiptRow[]` | Empty array — no upcoming receipts. |
| `itemRecentSales.five-mixed.json` | `RecentSale[]` | Five recent transactions in descending date order: 3 `CustInvc`, 1 `CashSale`, 1 `CustCred` (return). Exercises the multi-type schema. |
| `itemRecentSales.none.json` | `RecentSale[]` | Empty array — item with no sales activity. |
| `itemDemand.steady.json` | `DemandResultSchema` | Single SUM row with `avg_daily_demand = 2.5`. Drives the `kind: "ok"` branch of `runItemDemandQuery`. |
| `itemDemand.zero.json` | `DemandResultSchema` | Single SUM row with `avg_daily_demand = 0`. Drives the `kind: "no-demand"` branch. |

## MLI on vs MLI off

NetSuite's Multi-Location Inventory (MLI) feature is per-account. With MLI
on, the `inventoryitemlocations` table is populated and the
`itemLocations` query returns one row per (item, location) pair. With MLI
off, that table either doesn't exist or returns no rows.

The wrappers degrade gracefully:

- `runItemLocationsQuery` returns `[]` if the query throws an
  inventoryitemlocations-not-found error (MLI off) or if the row set is
  simply empty.
- `runItemHeaderQuery` uses `LEFT JOIN` and `NVL` so the aggregate query
  returns a row even when there are no per-location rows.

## How to reproduce against a real account

1. Open the NetSuite SuiteQL Query Tool (`/app/site/hosting/scriptlet.nl`
   path varies — see ARCHITECTURE.md).
2. Run the SQL from `src/lib/queries/itemHeader.ts`, substituting a real
   item internal id for the `?` parameter.
3. Confirm the column shape matches `ItemHeaderSchema` in the source
   file. Update the schema (and these fixtures) if any column is missing
   or returns an unexpected type.

If a real-account response surfaces a column type or shape not covered
by the mocks here, prefer **adding a new fixture file** rather than
mutating an existing one — tests reference the file names directly.
