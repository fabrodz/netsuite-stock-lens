/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { ItemLocationSchema, runItemLocationsQuery } from "@/lib/queries/itemLocations";
import { beforeEach, describe, expect, test, vi } from "vitest";
import locationsMliOff from "../fixtures/suiteql/itemLocations.mli-off.json";
import locationsMliOn from "../fixtures/suiteql/itemLocations.mli-on.json";

// Mock the bridge so the query wrapper can be exercised without a real
// page-context script. Each test replaces the mock's behaviour.
vi.mock("@/content/bridge", () => ({
  runSuiteQL: vi.fn(),
}));

// Re-import after the mock so we get the typed handle.
import { runSuiteQL } from "@/content/bridge";

const mockedRunSuiteQL = vi.mocked(runSuiteQL);

describe("ItemLocationSchema", () => {
  test("parses the canonical MLI-on fixture into typed rows", () => {
    for (const row of locationsMliOn) {
      const parsed = ItemLocationSchema.parse(row);
      expect(typeof parsed.location).toBe("string");
      expect(parsed.locationname.length).toBeGreaterThan(0);
      expect(parsed.quantityonhand).toBeGreaterThanOrEqual(0);
    }
  });

  test("coerces null locationname to empty string", () => {
    // Archived locations can return null for BUILTIN.DF — UI should never
    // render the literal word "null".
    const parsed = ItemLocationSchema.parse({
      location: 42,
      locationname: null,
      quantityonhand: "12",
      quantitycommitted: "0",
      quantityavailable: "12",
      quantityonorder: 0,
    });
    expect(parsed.locationname).toBe("");
    expect(parsed.location).toBe("42");
    expect(parsed.quantityonhand).toBe(12);
  });
});

describe("runItemLocationsQuery", () => {
  beforeEach(() => {
    mockedRunSuiteQL.mockReset();
  });

  test("returns typed rows for the MLI-on fixture", async () => {
    mockedRunSuiteQL.mockResolvedValueOnce(locationsMliOn as Record<string, unknown>[]);
    const rows = await runItemLocationsQuery("123");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.locationname).toBe("Main Warehouse");
    expect(rows[0]?.quantityavailable).toBe(50);
  });

  test("returns [] for the MLI-off fixture (empty rows)", async () => {
    mockedRunSuiteQL.mockResolvedValueOnce(locationsMliOff as Record<string, unknown>[]);
    const rows = await runItemLocationsQuery("123");
    expect(rows).toEqual([]);
  });

  test("treats the MLI-off error as an empty location set", async () => {
    // NetSuite returns a free-form error mentioning the table name when MLI
    // is disabled. We collapse that to [] so the rest of the popup renders.
    mockedRunSuiteQL.mockRejectedValueOnce(
      new Error("Record 'inventoryitemlocations' was not found."),
    );
    const rows = await runItemLocationsQuery("123");
    expect(rows).toEqual([]);
  });

  test("rethrows unrelated errors", async () => {
    // Timeout / permission errors must bubble up — the caller maps them to
    // friendly codes via error-mapping.ts.
    mockedRunSuiteQL.mockRejectedValueOnce(new Error("suiteql-timeout"));
    await expect(runItemLocationsQuery("123")).rejects.toThrow("suiteql-timeout");
  });

  test("skips malformed rows without failing the query", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockedRunSuiteQL.mockResolvedValueOnce([
      ...locationsMliOn,
      // Missing required `location` and bad quantity types — schema rejects.
      { quantityonhand: { not: "a number" }, locationname: 5 },
    ] as Record<string, unknown>[]);
    const rows = await runItemLocationsQuery("123");
    expect(rows).toHaveLength(3);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("rejects when called with a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runItemLocationsQuery("123", controller.signal)).rejects.toThrow("aborted");
  });
});
