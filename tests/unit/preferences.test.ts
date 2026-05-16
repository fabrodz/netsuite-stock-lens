/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_STORAGE_KEY,
  getPreferences,
  onPreferencesChanged,
  setPreferences,
} from "@/lib/preferences";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { __resetChromeStorage, __setChromeSyncValue } from "../setup";

describe("getPreferences", () => {
  beforeEach(() => {
    __resetChromeStorage();
    vi.restoreAllMocks();
  });

  test("returns DEFAULT_PREFERENCES when storage is empty", async () => {
    const prefs = await getPreferences();
    expect(prefs).toEqual(DEFAULT_PREFERENCES);
  });

  test("DEFAULT_PREFERENCES has the cross-record flags defaulted to false", () => {
    // Backstop for the "opt-in everything" design requirement: any
    // future drift in defaults will fail this test loudly.
    expect(DEFAULT_PREFERENCES.showRecentSales).toBe(false);
    expect(DEFAULT_PREFERENCES.showDemand).toBe(false);
  });

  test("DEFAULT_PREFERENCES has the prefetch flag off and N=10", () => {
    // Prefetch is opt-in: a fresh install must never silently warm the
    // cache. N=10 matches the design default; max is 25 (validated
    // separately in the setPreferences out-of-range test).
    expect(DEFAULT_PREFERENCES.prefetchEnabled).toBe(false);
    expect(DEFAULT_PREFERENCES.prefetchN).toBe(10);
  });

  test("returns stored preferences when valid", async () => {
    __setChromeSyncValue(PREFERENCES_STORAGE_KEY, {
      enabled: false,
      triggerMode: "long-press",
      hoverDelayMs: 600,
      showRecentSales: true,
      showDemand: true,
      prefetchEnabled: true,
      prefetchN: 25,
    });
    const prefs = await getPreferences();
    expect(prefs).toEqual({
      enabled: false,
      triggerMode: "long-press",
      hoverDelayMs: 600,
      showRecentSales: true,
      showDemand: true,
      prefetchEnabled: true,
      prefetchN: 25,
    });
  });

  test("fills missing fields with defaults", async () => {
    __setChromeSyncValue(PREFERENCES_STORAGE_KEY, { enabled: false });
    const prefs = await getPreferences();
    expect(prefs.enabled).toBe(false);
    expect(prefs.triggerMode).toBe(DEFAULT_PREFERENCES.triggerMode);
    expect(prefs.hoverDelayMs).toBe(DEFAULT_PREFERENCES.hoverDelayMs);
    // Cross-record fields are backfilled from defaults when an older install
    // upgrades — the stored blob never had them, so the merge must inject
    // the false defaults instead of letting Zod reject the shape.
    expect(prefs.showRecentSales).toBe(false);
    expect(prefs.showDemand).toBe(false);
    // Prefetch fields backfill the same way.
    expect(prefs.prefetchEnabled).toBe(false);
    expect(prefs.prefetchN).toBe(10);
  });

  test("older install (no cross-record fields stored) parses cleanly without warnings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // An older user's blob has only the pre-cross-record fields. The blob
    // shape mirrors the current defaults so the equality check stays
    // meaningful (the test's intent is backfill of new cross-record fields,
    // not the specific trigger mode).
    __setChromeSyncValue(PREFERENCES_STORAGE_KEY, {
      enabled: true,
      triggerMode: "hover-delay",
      hoverDelayMs: 400,
    });
    const prefs = await getPreferences();
    expect(prefs).toEqual(DEFAULT_PREFERENCES);
    // No warning should fire — the merge with defaults backfills the new
    // Cross-record fields before validation.
    expect(warn).not.toHaveBeenCalled();
  });

  test("falls back to defaults and warns when stored shape is invalid", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    __setChromeSyncValue(PREFERENCES_STORAGE_KEY, {
      enabled: "yes",
      triggerMode: "explode-on-hover",
      hoverDelayMs: 50,
    });
    const prefs = await getPreferences();
    expect(prefs).toEqual(DEFAULT_PREFERENCES);
    expect(warn).toHaveBeenCalledOnce();
  });

  test("falls back to defaults when stored value is a primitive", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    __setChromeSyncValue(PREFERENCES_STORAGE_KEY, "not-an-object");
    const prefs = await getPreferences();
    // Strings are coerced to defaults without producing an error from Zod
    // because the merge produces a valid object, but the warn path triggers
    // only on parse failure — a string falls through as DEFAULT_PREFERENCES.
    expect(prefs).toEqual(DEFAULT_PREFERENCES);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("setPreferences", () => {
  beforeEach(() => {
    __resetChromeStorage();
  });

  test("merges patch into existing preferences", async () => {
    await setPreferences({ triggerMode: "hover-delay" });
    const after = await setPreferences({ hoverDelayMs: 750 });
    expect(after).toEqual({
      ...DEFAULT_PREFERENCES,
      triggerMode: "hover-delay",
      hoverDelayMs: 750,
    });
  });

  test("persists merged preferences to storage", async () => {
    await setPreferences({ enabled: false });
    const reread = await getPreferences();
    expect(reread.enabled).toBe(false);
  });

  test("round-trips cross-record fields through storage", async () => {
    await setPreferences({ showRecentSales: true, showDemand: true });
    const reread = await getPreferences();
    expect(reread.showRecentSales).toBe(true);
    expect(reread.showDemand).toBe(true);
  });

  test("round-trips prefetch fields through storage", async () => {
    await setPreferences({ prefetchEnabled: true, prefetchN: 15 });
    const reread = await getPreferences();
    expect(reread.prefetchEnabled).toBe(true);
    expect(reread.prefetchN).toBe(15);
  });

  test("rejects prefetchN outside 1..25", async () => {
    await expect(setPreferences({ prefetchN: 0 })).rejects.toThrow();
    await expect(setPreferences({ prefetchN: 26 })).rejects.toThrow();
  });

  test("throws when the merged result is invalid", async () => {
    await expect(setPreferences({ hoverDelayMs: 5 })).rejects.toThrow();
  });
});

describe("onPreferencesChanged", () => {
  beforeEach(() => {
    __resetChromeStorage();
  });

  test("fires listener with typed next and previous values", async () => {
    const listener = vi.fn();
    onPreferencesChanged(listener);
    await setPreferences({ enabled: false });
    expect(listener).toHaveBeenCalledOnce();
    const [next, previous] = listener.mock.calls[0] ?? [];
    expect(next).toEqual({ ...DEFAULT_PREFERENCES, enabled: false });
    // Previous was empty storage -> defaults.
    expect(previous).toEqual(DEFAULT_PREFERENCES);
  });

  test("fires listener when a cross-record field changes", async () => {
    const listener = vi.fn();
    onPreferencesChanged(listener);
    await setPreferences({ showDemand: true });
    expect(listener).toHaveBeenCalledOnce();
    const [next] = listener.mock.calls[0] ?? [];
    expect(next.showDemand).toBe(true);
    expect(next.showRecentSales).toBe(false);
  });

  test("unsubscribe stops receiving events", async () => {
    const listener = vi.fn();
    const unsubscribe = onPreferencesChanged(listener);
    await setPreferences({ enabled: false });
    unsubscribe();
    await setPreferences({ enabled: true });
    expect(listener).toHaveBeenCalledOnce();
  });

  test("ignores changes for unrelated storage keys", async () => {
    const listener = vi.fn();
    onPreferencesChanged(listener);
    await chrome.storage.sync.set({ "some.other.key": "value" });
    expect(listener).not.toHaveBeenCalled();
  });
});
