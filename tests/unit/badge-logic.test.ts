/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { badgeColor } from "@/content/popup/badge";
import { describe, expect, test } from "vitest";

describe("badgeColor", () => {
  test("hidden when line qty is null", () => {
    expect(badgeColor(10, null)).toBe("hidden");
    expect(badgeColor(0, null)).toBe("hidden");
    expect(badgeColor(-5, null)).toBe("hidden");
  });

  test("red when available is zero or negative", () => {
    expect(badgeColor(0, 1)).toBe("red");
    expect(badgeColor(-3, 5)).toBe("red");
  });

  test("yellow when available is positive but less than line qty", () => {
    expect(badgeColor(2, 5)).toBe("yellow");
    expect(badgeColor(0.5, 1)).toBe("yellow");
  });

  test("green when available is equal to line qty", () => {
    expect(badgeColor(5, 5)).toBe("green");
  });

  test("green when available is greater than line qty", () => {
    expect(badgeColor(10, 1)).toBe("green");
    expect(badgeColor(1, 0.5)).toBe("green");
  });

  test("handles fractional quantities at the green/yellow boundary", () => {
    // Available 1.5, line 1.5 -> just enough.
    expect(badgeColor(1.5, 1.5)).toBe("green");
    // Available 1.4, line 1.5 -> short.
    expect(badgeColor(1.4, 1.5)).toBe("yellow");
  });
});
