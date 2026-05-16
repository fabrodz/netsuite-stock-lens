import { parseAccountId } from "@/lib/accountId";
/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { describe, expect, test } from "vitest";

describe("parseAccountId", () => {
  test("extracts numeric production account from app.netsuite.com host", () => {
    expect(parseAccountId("1234567.app.netsuite.com")).toBe("1234567");
  });

  test("extracts TSTDRV sandbox account from app.netsuite.com host", () => {
    expect(parseAccountId("TSTDRV1234567.app.netsuite.com")).toBe("TSTDRV1234567");
  });

  test("extracts hyphenated sandbox account (e.g. -sb1, -sb2)", () => {
    expect(parseAccountId("6956436-sb2.app.netsuite.com")).toBe("6956436-sb2");
    expect(parseAccountId("1234567-sb1.app.netsuite.com")).toBe("1234567-sb1");
  });

  test("extracts release preview account (-rp)", () => {
    expect(parseAccountId("1234567-rp.app.netsuite.com")).toBe("1234567-rp");
  });

  test("returns null for system.netsuite.com", () => {
    expect(parseAccountId("system.netsuite.com")).toBeNull();
  });

  test("returns null for non-account hosts", () => {
    expect(parseAccountId("example.com")).toBeNull();
  });
});
