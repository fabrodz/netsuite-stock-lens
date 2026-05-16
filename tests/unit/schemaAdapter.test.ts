/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { shouldSkipQuery } from "@/lib/schemaAdapter";
import type { SchemaProbeResult } from "@/lib/schemaProbe";
import { describe, expect, test } from "vitest";

function makeProbe(overrides: Partial<SchemaProbeResult> = {}): SchemaProbeResult {
  return {
    accountId: "TST1",
    probedAt: 0,
    mliEnabled: true,
    binTracking: true,
    lotsAndSerials: true,
    ...overrides,
  };
}

describe("shouldSkipQuery", () => {
  test("never skips when schema is null (probe not resolved yet)", () => {
    // Conservative default: pay the round-trip rather than hide data
    // because we don't know the schema yet.
    for (const q of [
      "itemLocations",
      "itemNextReceipt",
      "itemRecentSales",
      "itemDemand",
    ] as const) {
      expect(shouldSkipQuery(null, q)).toBe(false);
    }
  });

  test("skips itemLocations when MLI is disabled", () => {
    const probe = makeProbe({ mliEnabled: false });
    expect(shouldSkipQuery(probe, "itemLocations")).toBe(true);
  });

  test("does not skip itemLocations when MLI is enabled", () => {
    const probe = makeProbe({ mliEnabled: true });
    expect(shouldSkipQuery(probe, "itemLocations")).toBe(false);
  });

  test("never skips itemNextReceipt regardless of schema", () => {
    expect(shouldSkipQuery(makeProbe({ mliEnabled: false }), "itemNextReceipt")).toBe(false);
    expect(shouldSkipQuery(makeProbe({ mliEnabled: true }), "itemNextReceipt")).toBe(false);
  });

  test("never skips itemRecentSales or itemDemand regardless of schema", () => {
    expect(shouldSkipQuery(makeProbe({ mliEnabled: false }), "itemRecentSales")).toBe(false);
    expect(shouldSkipQuery(makeProbe({ mliEnabled: false }), "itemDemand")).toBe(false);
    expect(shouldSkipQuery(makeProbe({ mliEnabled: true }), "itemRecentSales")).toBe(false);
    expect(shouldSkipQuery(makeProbe({ mliEnabled: true }), "itemDemand")).toBe(false);
  });

  test("bin / lot flags do not currently gate any queries", () => {
    // These are reserved for future query gating; the adapter must
    // not preemptively skip queries based on them.
    const probe = makeProbe({ mliEnabled: true, binTracking: false, lotsAndSerials: false });
    expect(shouldSkipQuery(probe, "itemLocations")).toBe(false);
    expect(shouldSkipQuery(probe, "itemNextReceipt")).toBe(false);
    expect(shouldSkipQuery(probe, "itemRecentSales")).toBe(false);
    expect(shouldSkipQuery(probe, "itemDemand")).toBe(false);
  });
});
