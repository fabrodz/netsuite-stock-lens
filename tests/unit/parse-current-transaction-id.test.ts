/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { parseCurrentTransactionId } from "@/lib/surfaces";
import { describe, expect, test } from "vitest";

describe("parseCurrentTransactionId", () => {
  test("returns the id from a simple ?id= URL", () => {
    expect(
      parseCurrentTransactionId(
        "https://1234567.app.netsuite.com/app/accounting/transactions/purchord.nl?id=123",
      ),
    ).toBe("123");
  });

  test("returns the id when other params precede it", () => {
    // Real NetSuite often appends ?whence= for back-navigation context; the
    // id is rarely first.
    expect(
      parseCurrentTransactionId(
        "https://1234567.app.netsuite.com/app/accounting/transactions/transord.nl?whence=foo&id=987",
      ),
    ).toBe("987");
  });

  test("returns null when no id param is present (new-record page)", () => {
    // The PO/TO entry pages with no `id` mean "create new"; nothing to exclude.
    expect(
      parseCurrentTransactionId(
        "https://1234567.app.netsuite.com/app/accounting/transactions/purchord.nl",
      ),
    ).toBeNull();
  });

  test("returns the raw string for a non-numeric id", () => {
    // Caller decides what to do with non-numeric ids; the parser stays cheap
    // and lossless rather than asserting numeric-only.
    expect(
      parseCurrentTransactionId(
        "https://1234567.app.netsuite.com/app/accounting/transactions/purchord.nl?id=abc",
      ),
    ).toBe("abc");
  });
});
