/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { runItemDemandQuery } from "@/lib/queries/itemDemand";
import { beforeEach, describe, expect, test, vi } from "vitest";
import demandSteady from "../fixtures/suiteql/itemDemand.steady.json";
import demandZero from "../fixtures/suiteql/itemDemand.zero.json";

vi.mock("@/content/bridge", () => ({
  runSuiteQL: vi.fn(),
}));

import { runSuiteQL } from "@/content/bridge";

const mockedRunSuiteQL = vi.mocked(runSuiteQL);

describe("runItemDemandQuery — kind branches", () => {
  beforeEach(() => {
    mockedRunSuiteQL.mockReset();
  });

  test('returns kind "ok" with daysOfStock when demand > 0 and available > 0', async () => {
    mockedRunSuiteQL.mockResolvedValueOnce(demandSteady as Record<string, unknown>[]);
    const result = await runItemDemandQuery("123", 25);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return; // narrow for TS
    expect(result.avgDailyDemand).toBe(2.5);
    // Math.round(25 / 2.5) === 10
    expect(result.daysOfStock).toBe(10);
  });

  test('returns kind "no-demand" when avg_daily_demand is 0', async () => {
    mockedRunSuiteQL.mockResolvedValueOnce(demandZero as Record<string, unknown>[]);
    const result = await runItemDemandQuery("123", 50);
    expect(result.kind).toBe("no-demand");
    if (result.kind === "no-demand") {
      expect(result.avgDailyDemand).toBe(0);
    }
  });

  test('returns kind "backordered" when available < 0', async () => {
    mockedRunSuiteQL.mockResolvedValueOnce(demandSteady as Record<string, unknown>[]);
    const result = await runItemDemandQuery("123", -5);
    expect(result.kind).toBe("backordered");
    if (result.kind === "backordered") {
      // backordered preserves the avg_daily_demand value so the UI can
      // still show the demand number alongside the warning.
      expect(result.avgDailyDemand).toBe(2.5);
    }
  });

  test('returns kind "unavailable" on permission errors', async () => {
    mockedRunSuiteQL.mockRejectedValueOnce(new Error("Permission Violation"));
    const result = await runItemDemandQuery("123", 10);
    expect(result.kind).toBe("unavailable");
    if (result.kind === "unavailable") {
      expect(result.avgDailyDemand).toBe(0);
    }
  });

  test('returns kind "unavailable" on transaction-not-found errors', async () => {
    mockedRunSuiteQL.mockRejectedValueOnce(new Error("transaction table not found"));
    const result = await runItemDemandQuery("123", 10);
    expect(result.kind).toBe("unavailable");
  });

  test("rethrows unrelated errors", async () => {
    mockedRunSuiteQL.mockRejectedValueOnce(new Error("suiteql-timeout"));
    await expect(runItemDemandQuery("123", 10)).rejects.toThrow("suiteql-timeout");
  });
});

describe("runItemDemandQuery — boundary cases", () => {
  beforeEach(() => {
    mockedRunSuiteQL.mockReset();
  });

  test('available === 0 with demand > 0 → "ok" with daysOfStock 0', async () => {
    mockedRunSuiteQL.mockResolvedValueOnce(demandSteady as Record<string, unknown>[]);
    const result = await runItemDemandQuery("123", 0);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.daysOfStock).toBe(0);
    }
  });

  test('available > 0 with demand === 0 → "no-demand"', async () => {
    mockedRunSuiteQL.mockResolvedValueOnce(demandZero as Record<string, unknown>[]);
    const result = await runItemDemandQuery("123", 100);
    expect(result.kind).toBe("no-demand");
  });

  test('available < 0 with demand === 0 → "backordered" (backorder wins over no-demand)', async () => {
    mockedRunSuiteQL.mockResolvedValueOnce(demandZero as Record<string, unknown>[]);
    const result = await runItemDemandQuery("123", -10);
    expect(result.kind).toBe("backordered");
    if (result.kind === "backordered") {
      expect(result.avgDailyDemand).toBe(0);
    }
  });

  test("empty result set defends to no-demand", async () => {
    // The SUM should always return one row, but if SuiteQL returns an empty
    // array (some frontends drop NULL-only rows), the wrapper defaults to
    // avgDailyDemand = 0 and emits kind "no-demand".
    mockedRunSuiteQL.mockResolvedValueOnce([] as Record<string, unknown>[]);
    const result = await runItemDemandQuery("123", 50);
    expect(result.kind).toBe("no-demand");
  });

  test("rounds daysOfStock to nearest integer", async () => {
    mockedRunSuiteQL.mockResolvedValueOnce(demandSteady as Record<string, unknown>[]);
    // available 11 / demand 2.5 = 4.4 → round to 4
    const result = await runItemDemandQuery("123", 11);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.daysOfStock).toBe(4);
    }
  });

  test("rejects when called with a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runItemDemandQuery("123", 10, controller.signal)).rejects.toThrow("aborted");
  });

  test("coerces string avg_daily_demand to number", async () => {
    mockedRunSuiteQL.mockResolvedValueOnce([{ avg_daily_demand: "3.0" }] as Record<
      string,
      unknown
    >[]);
    const result = await runItemDemandQuery("123", 30);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.avgDailyDemand).toBe(3);
      expect(result.daysOfStock).toBe(10);
    }
  });
});
