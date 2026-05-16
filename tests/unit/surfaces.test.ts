/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { isListViewSurface, urlToSurface } from "@/lib/surfaces";
import { describe, expect, test } from "vitest";

describe("urlToSurface", () => {
  test("maps Sales Order URL to 'sales-order'", () => {
    expect(
      urlToSurface("https://1234567.app.netsuite.com/app/accounting/transactions/salesord.nl"),
    ).toBe("sales-order");
  });

  test("maps Sales Order URL with query params to 'sales-order'", () => {
    expect(
      urlToSurface(
        "https://1234567.app.netsuite.com/app/accounting/transactions/salesord.nl?id=42",
      ),
    ).toBe("sales-order");
  });

  test("maps Quote/Estimate URL to 'quote'", () => {
    expect(
      urlToSurface("https://1234567.app.netsuite.com/app/accounting/transactions/estimate.nl"),
    ).toBe("quote");
  });

  test("maps Quote URL with query params to 'quote'", () => {
    expect(
      urlToSurface(
        "https://TSTDRV1234567.app.netsuite.com/app/accounting/transactions/estimate.nl?id=1&whence=",
      ),
    ).toBe("quote");
  });

  test("maps Invoice URL to 'invoice'", () => {
    expect(
      urlToSurface("https://1234567.app.netsuite.com/app/accounting/transactions/custinvc.nl"),
    ).toBe("invoice");
  });

  test("maps Invoice URL with query params to 'invoice'", () => {
    expect(
      urlToSurface(
        "https://1234567.app.netsuite.com/app/accounting/transactions/custinvc.nl?id=99&whence=",
      ),
    ).toBe("invoice");
  });

  test("maps Item Fulfillment URL to 'item-fulfillment'", () => {
    expect(
      urlToSurface("https://1234567.app.netsuite.com/app/accounting/transactions/itemship.nl"),
    ).toBe("item-fulfillment");
  });

  test("maps Item Fulfillment URL with query params to 'item-fulfillment'", () => {
    expect(
      urlToSurface(
        "https://TSTDRV1234567.app.netsuite.com/app/accounting/transactions/itemship.nl?id=7",
      ),
    ).toBe("item-fulfillment");
  });

  test("returns null for an unrelated NetSuite URL", () => {
    expect(
      urlToSurface("https://1234567.app.netsuite.com/app/common/item/item.nl?id=123"),
    ).toBeNull();
  });

  test("returns null for a non-NetSuite host", () => {
    expect(urlToSurface("https://example.com/app/accounting/transactions/salesord.nl")).toBeNull();
  });

  test("returns null for system.netsuite.com (not an account host)", () => {
    expect(
      urlToSurface("https://system.netsuite.com/app/accounting/transactions/salesord.nl"),
    ).toBeNull();
  });

  test("returns null for a malformed URL string", () => {
    expect(urlToSurface("not a url")).toBeNull();
  });

  test("accepts a URL instance directly", () => {
    const url = new URL("https://1234567.app.netsuite.com/app/accounting/transactions/salesord.nl");
    expect(urlToSurface(url)).toBe("sales-order");
  });

  test("does not match an extra path segment after salesord.nl", () => {
    // The trailing `/` would extend the path; pattern requires end-of-path
    // or a query string immediately after `.nl`.
    expect(
      urlToSurface("https://1234567.app.netsuite.com/app/accounting/transactions/salesord.nl/"),
    ).toBeNull();
  });

  // --- Purchasing + transfer surfaces. ---

  test("maps Purchase Order URL to 'purchase-order'", () => {
    expect(
      urlToSurface("https://1234567.app.netsuite.com/app/accounting/transactions/purchord.nl"),
    ).toBe("purchase-order");
  });

  test("maps Purchase Order URL with query params to 'purchase-order'", () => {
    expect(
      urlToSurface(
        "https://1234567.app.netsuite.com/app/accounting/transactions/purchord.nl?id=12345",
      ),
    ).toBe("purchase-order");
  });

  test("maps Vendor Bill URL to 'vendor-bill'", () => {
    expect(
      urlToSurface("https://1234567.app.netsuite.com/app/accounting/transactions/vendbill.nl"),
    ).toBe("vendor-bill");
  });

  test("maps Vendor Bill URL with query params to 'vendor-bill'", () => {
    expect(
      urlToSurface(
        "https://TSTDRV1234567.app.netsuite.com/app/accounting/transactions/vendbill.nl?id=7&whence=",
      ),
    ).toBe("vendor-bill");
  });

  test("maps Transfer Order URL to 'transfer-order'", () => {
    expect(
      urlToSurface("https://1234567.app.netsuite.com/app/accounting/transactions/transord.nl"),
    ).toBe("transfer-order");
  });

  test("maps Transfer Order URL with query params to 'transfer-order'", () => {
    expect(
      urlToSurface(
        "https://1234567.app.netsuite.com/app/accounting/transactions/transord.nl?id=42&whence=foo",
      ),
    ).toBe("transfer-order");
  });

  // --- Warehouse-flow transaction surfaces. ---

  test("maps Item Receipt URL to 'item-receipt'", () => {
    expect(
      urlToSurface("https://1234567.app.netsuite.com/app/accounting/transactions/itemrcpt.nl"),
    ).toBe("item-receipt");
  });

  test("maps Item Receipt URL with query params to 'item-receipt'", () => {
    expect(
      urlToSurface(
        "https://1234567.app.netsuite.com/app/accounting/transactions/itemrcpt.nl?id=99&whence=",
      ),
    ).toBe("item-receipt");
  });

  test("maps Inventory Adjustment URL to 'inventory-adjustment'", () => {
    expect(
      urlToSurface("https://1234567.app.netsuite.com/app/accounting/transactions/invadjst.nl"),
    ).toBe("inventory-adjustment");
  });

  test("maps Inventory Adjustment URL with query params to 'inventory-adjustment'", () => {
    expect(
      urlToSurface(
        "https://TSTDRV1234567.app.netsuite.com/app/accounting/transactions/invadjst.nl?id=5",
      ),
    ).toBe("inventory-adjustment");
  });

  test("maps Inventory Count URL to 'inventory-count'", () => {
    expect(
      urlToSurface("https://1234567.app.netsuite.com/app/accounting/transactions/invcount.nl"),
    ).toBe("inventory-count");
  });

  test("maps Inventory Count URL with query params to 'inventory-count'", () => {
    expect(
      urlToSurface(
        "https://1234567.app.netsuite.com/app/accounting/transactions/invcount.nl?id=33&whence=foo",
      ),
    ).toBe("inventory-count");
  });

  // --- List-view surfaces. ---

  test("maps Saved Search results URL to 'saved-search'", () => {
    expect(
      urlToSurface("https://1234567.app.netsuite.com/app/common/search/searchresults.nl"),
    ).toBe("saved-search");
  });

  test("maps Saved Search results URL with query params to 'saved-search'", () => {
    expect(
      urlToSurface(
        "https://1234567.app.netsuite.com/app/common/search/searchresults.nl?searchid=42",
      ),
    ).toBe("saved-search");
  });

  test("maps Item List URL to 'item-list'", () => {
    expect(urlToSurface("https://1234567.app.netsuite.com/app/common/item/itemlist.nl")).toBe(
      "item-list",
    );
  });

  test("maps Item List URL with query params to 'item-list'", () => {
    expect(
      urlToSurface(
        "https://TSTDRV1234567.app.netsuite.com/app/common/item/itemlist.nl?Item_TYPE=InvtPart",
      ),
    ).toBe("item-list");
  });

  test("maps Report URL (report.nl) to 'report'", () => {
    expect(urlToSurface("https://1234567.app.netsuite.com/app/reporting/report.nl")).toBe("report");
  });

  test("maps Report Builder URL with query params to 'report'", () => {
    expect(
      urlToSurface(
        "https://1234567.app.netsuite.com/app/reporting/reportbuilder.nl?id=customrptbuilder_3",
      ),
    ).toBe("report");
  });
});

describe("isListViewSurface", () => {
  test("returns true for 'saved-search'", () => {
    expect(isListViewSurface("saved-search")).toBe(true);
  });

  test("returns true for 'item-list'", () => {
    expect(isListViewSurface("item-list")).toBe(true);
  });

  test("returns true for 'report'", () => {
    expect(isListViewSurface("report")).toBe(true);
  });

  test("returns false for transaction surfaces", () => {
    // One assertion across every transaction surface keeps the test
    // tightly coupled to the SurfaceKey union: adding a new transaction
    // surface forces an explicit choice here.
    const transactionKeys = [
      "sales-order",
      "quote",
      "invoice",
      "item-fulfillment",
      "purchase-order",
      "vendor-bill",
      "transfer-order",
      "item-receipt",
      "inventory-adjustment",
      "inventory-count",
    ] as const;
    for (const k of transactionKeys) {
      expect(isListViewSurface(k)).toBe(false);
    }
  });
});
