/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { mapSuiteQLError } from "@/lib/queries/error-mapping";
import { describe, expect, test } from "vitest";

describe("mapSuiteQLError", () => {
  test("maps the bridge timeout marker", () => {
    expect(mapSuiteQLError(new Error("suiteql-timeout"))).toBe("timeout");
  });

  test("maps the injected-script unavailability marker", () => {
    expect(mapSuiteQLError(new Error("n-query-unavailable"))).toBe("n-query-unavailable");
  });

  test("maps the item-not-found marker", () => {
    expect(mapSuiteQLError(new Error("item-not-found"))).toBe("item-not-found");
  });

  test("maps the MLI-off table error", () => {
    expect(mapSuiteQLError(new Error("Record 'inventoryitemlocations' was not found."))).toBe(
      "inventory-not-enabled",
    );
  });

  test("maps permission keywords (case-insensitive)", () => {
    expect(mapSuiteQLError(new Error("Permission Violation"))).toBe("no-permission");
    expect(mapSuiteQLError(new Error("Insufficient privilege"))).toBe("no-permission");
    expect(mapSuiteQLError(new Error("ROLE_RESTRICTION"))).toBe("no-permission");
  });

  test("maps unknown errors to 'unknown'", () => {
    expect(mapSuiteQLError(new Error("totally unexpected"))).toBe("unknown");
    expect(mapSuiteQLError("a string, not an Error")).toBe("unknown");
    expect(mapSuiteQLError(undefined)).toBe("unknown");
    expect(mapSuiteQLError(null)).toBe("unknown");
  });
});
