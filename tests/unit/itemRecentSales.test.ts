/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { RecentSaleSchema, runItemRecentSalesQuery } from "@/lib/queries/itemRecentSales";
import { beforeEach, describe, expect, test, vi } from "vitest";
import recentSalesFiveMixed from "../fixtures/suiteql/itemRecentSales.five-mixed.json";
import recentSalesNone from "../fixtures/suiteql/itemRecentSales.none.json";

vi.mock("@/content/bridge", () => ({
  runSuiteQL: vi.fn(),
}));

import { runSuiteQL } from "@/content/bridge";

const mockedRunSuiteQL = vi.mocked(runSuiteQL);

describe("RecentSaleSchema", () => {
  test("parses every row of the five-mixed fixture", () => {
    for (const row of recentSalesFiveMixed) {
      const parsed = RecentSaleSchema.parse(row);
      expect(typeof parsed.tranid).toBe("string");
      expect(typeof parsed.quantity).toBe("number");
      expect(typeof parsed.rate).toBe("number");
      expect(typeof parsed.type).toBe("string");
    }
  });

  test("preserves the three transaction types verbatim", () => {
    // The popup distinguishes invoice vs cash sale vs credit memo by the
    // raw NetSuite type code; the schema must NOT collapse them.
    const types = recentSalesFiveMixed.map((row) => RecentSaleSchema.parse(row).type);
    expect(types).toContain("CustInvc");
    expect(types).toContain("CashSale");
    expect(types).toContain("CustCred");
  });

  test("collapses null customer to empty string", () => {
    const parsed = RecentSaleSchema.parse({
      tranid: "INV9999",
      trandate: "2026-05-01",
      customer: null,
      quantity: 1,
      rate: 9.99,
      type: "CustInvc",
    });
    expect(parsed.customer).toBe("");
  });

  test("collapses null rate to 0", () => {
    const parsed = RecentSaleSchema.parse({
      tranid: "INV9999",
      trandate: "2026-05-01",
      customer: "Test",
      quantity: 1,
      rate: null,
      type: "CustInvc",
    });
    expect(parsed.rate).toBe(0);
  });

  test("coerces string quantity to number", () => {
    const parsed = RecentSaleSchema.parse({
      tranid: "INV9999",
      trandate: "2026-05-01",
      customer: "Test",
      quantity: "7",
      rate: "12.50",
      type: "CashSale",
    });
    expect(parsed.quantity).toBe(7);
    expect(parsed.rate).toBe(12.5);
  });
});

describe("runItemRecentSalesQuery", () => {
  beforeEach(() => {
    mockedRunSuiteQL.mockReset();
  });

  test("returns five typed rows for the five-mixed fixture", async () => {
    mockedRunSuiteQL.mockResolvedValueOnce(recentSalesFiveMixed as Record<string, unknown>[]);
    const rows = await runItemRecentSalesQuery("123");
    expect(rows).toHaveLength(5);
    expect(rows[0]?.tranid).toBe("INV5005");
    expect(rows[4]?.type).toBe("CustCred");
    // Quantity for the credit memo is negative — the schema must not flip
    // the sign.
    expect(rows[4]?.quantity).toBe(-1);
  });

  test("returns [] for the empty fixture", async () => {
    mockedRunSuiteQL.mockResolvedValueOnce(recentSalesNone as Record<string, unknown>[]);
    const rows = await runItemRecentSalesQuery("123");
    expect(rows).toEqual([]);
  });

  test("collapses permission errors to []", async () => {
    mockedRunSuiteQL.mockRejectedValueOnce(
      new Error("Permission Violation: Insufficient privilege"),
    );
    const rows = await runItemRecentSalesQuery("123");
    expect(rows).toEqual([]);
  });

  test("collapses transaction-not-found errors to []", async () => {
    mockedRunSuiteQL.mockRejectedValueOnce(new Error("Transaction table not found"));
    const rows = await runItemRecentSalesQuery("123");
    expect(rows).toEqual([]);
  });

  test("rethrows unrelated errors", async () => {
    mockedRunSuiteQL.mockRejectedValueOnce(new Error("suiteql-timeout"));
    await expect(runItemRecentSalesQuery("123")).rejects.toThrow("suiteql-timeout");
  });

  test("skips malformed rows without failing the query", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockedRunSuiteQL.mockResolvedValueOnce([
      ...recentSalesFiveMixed,
      // Missing tranid (required) — schema rejects this row.
      { trandate: "2026-05-01", quantity: 1, rate: 1, type: "CustInvc" },
    ] as Record<string, unknown>[]);
    const rows = await runItemRecentSalesQuery("123");
    expect(rows).toHaveLength(5);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("rejects when called with a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runItemRecentSalesQuery("123", controller.signal)).rejects.toThrow("aborted");
  });
});
