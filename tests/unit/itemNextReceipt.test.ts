/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import {
  ITEM_NEXT_RECEIPT_EXCLUDE_QUERY,
  ITEM_NEXT_RECEIPT_QUERY,
  NextReceiptRowSchema,
  runItemNextReceiptQuery,
} from "@/lib/queries/itemNextReceipt";
import { beforeEach, describe, expect, test, vi } from "vitest";
import nextReceiptNone from "../fixtures/suiteql/itemNextReceipt.none.json";
import nextReceiptThreePos from "../fixtures/suiteql/itemNextReceipt.three-pos.json";

vi.mock("@/content/bridge", () => ({
  runSuiteQL: vi.fn(),
}));

import { runSuiteQL } from "@/content/bridge";

const mockedRunSuiteQL = vi.mocked(runSuiteQL);

describe("NextReceiptRowSchema", () => {
  test("parses the canonical three-PO fixture", () => {
    for (const row of nextReceiptThreePos) {
      const parsed = NextReceiptRowSchema.parse(row);
      expect(typeof parsed.trxid).toBe("string");
      expect(parsed.quantity).toBeGreaterThan(0);
    }
  });

  test("coerces null vendor to empty string", () => {
    const parsed = NextReceiptRowSchema.parse({
      tranid: "PO9999",
      trandate: "2026-05-10",
      vendor: null,
      quantity: "5",
      duedate: null,
      trxid: 7777,
    });
    expect(parsed.vendor).toBe("");
    expect(parsed.quantity).toBe(5);
    expect(parsed.trxid).toBe("7777");
  });
});

describe("runItemNextReceiptQuery", () => {
  beforeEach(() => {
    mockedRunSuiteQL.mockReset();
  });

  test("returns three typed rows for the three-PO fixture", async () => {
    mockedRunSuiteQL.mockResolvedValueOnce(nextReceiptThreePos as Record<string, unknown>[]);
    const rows = await runItemNextReceiptQuery("123");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.tranid).toBe("PO1001");
    expect(rows[2]?.vendor).toBe("Acme Supply Co");
  });

  test("returns [] for the empty fixture", async () => {
    mockedRunSuiteQL.mockResolvedValueOnce(nextReceiptNone as Record<string, unknown>[]);
    const rows = await runItemNextReceiptQuery("123");
    expect(rows).toEqual([]);
  });

  test("collapses permission errors to []", async () => {
    // A role without transaction access shouldn't break the popup; the
    // wrapper degrades silently and lets the popup render the rest.
    mockedRunSuiteQL.mockRejectedValueOnce(
      new Error("Permission Violation: Insufficient privilege"),
    );
    const rows = await runItemNextReceiptQuery("123");
    expect(rows).toEqual([]);
  });

  test("rethrows unrelated errors", async () => {
    mockedRunSuiteQL.mockRejectedValueOnce(new Error("suiteql-timeout"));
    await expect(runItemNextReceiptQuery("123")).rejects.toThrow("suiteql-timeout");
  });

  test("skips malformed rows without failing the query", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mockedRunSuiteQL.mockResolvedValueOnce([
      ...nextReceiptThreePos,
      // Missing tranid (required) — schema rejects.
      { trandate: "2026-05-01", quantity: 1, trxid: "x" },
    ] as Record<string, unknown>[]);
    const rows = await runItemNextReceiptQuery("123");
    expect(rows).toHaveLength(3);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("rejects when called with a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runItemNextReceiptQuery("123", controller.signal)).rejects.toThrow("aborted");
  });

  test("rejects when called with a pre-aborted signal via options object", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runItemNextReceiptQuery("123", { signal: controller.signal })).rejects.toThrow(
      "aborted",
    );
  });
});

describe("runItemNextReceiptQuery — excludeTrxId variant", () => {
  beforeEach(() => {
    mockedRunSuiteQL.mockReset();
  });

  test("uses the exclude query and appends excludeTrxId to params", async () => {
    mockedRunSuiteQL.mockResolvedValueOnce(nextReceiptThreePos as Record<string, unknown>[]);
    await runItemNextReceiptQuery("123", { excludeTrxId: "555" });
    expect(mockedRunSuiteQL).toHaveBeenCalledOnce();
    const [sql, params] = mockedRunSuiteQL.mock.calls[0] ?? [];
    expect(sql).toBe(ITEM_NEXT_RECEIPT_EXCLUDE_QUERY);
    expect(params).toEqual(["123", "555"]);
  });

  test("uses the base query and a single param when excludeTrxId is omitted", async () => {
    mockedRunSuiteQL.mockResolvedValueOnce(nextReceiptThreePos as Record<string, unknown>[]);
    await runItemNextReceiptQuery("123");
    const [sql, params] = mockedRunSuiteQL.mock.calls[0] ?? [];
    expect(sql).toBe(ITEM_NEXT_RECEIPT_QUERY);
    expect(params).toEqual(["123"]);
  });

  test("supports numeric excludeTrxId", async () => {
    mockedRunSuiteQL.mockResolvedValueOnce([] as Record<string, unknown>[]);
    await runItemNextReceiptQuery(123, { excludeTrxId: 555 });
    const [, params] = mockedRunSuiteQL.mock.calls[0] ?? [];
    expect(params).toEqual([123, 555]);
  });

  test("exclude query SQL contains the t.id != ? clause", () => {
    expect(ITEM_NEXT_RECEIPT_EXCLUDE_QUERY).toContain("t.id != ?");
    // Base query must NOT contain the exclusion clause; that's the whole
    // point of keeping them as separate constants.
    expect(ITEM_NEXT_RECEIPT_QUERY).not.toContain("t.id != ?");
  });

  test("combines excludeTrxId with a signal in the options object", async () => {
    mockedRunSuiteQL.mockResolvedValueOnce(nextReceiptThreePos as Record<string, unknown>[]);
    const controller = new AbortController();
    const rows = await runItemNextReceiptQuery("123", {
      excludeTrxId: "555",
      signal: controller.signal,
    });
    expect(rows).toHaveLength(3);
  });
});
