import type { DetectedItem } from "@/content/detection";
import { type HoverHandle, createHover } from "@/content/hover";
import type { Preferences } from "@/lib/preferences";
/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const DEFAULT_PREFS: Preferences = {
  enabled: true,
  triggerMode: "shift-hover",
  hoverDelayMs: 400,
  // Cross-record flags (all off by default — preserved here so the
  // shape stays in sync with the schema; hover.ts doesn't read them).
  showRecentSales: false,
  showDemand: false,
  // Prefetch flags (all off by default — preserved here so the
  // shape stays in sync with the schema; hover.ts doesn't read them).
  prefetchEnabled: false,
  prefetchN: 10,
};

function makeDetected(): DetectedItem {
  const el = document.createElement("a");
  document.body.appendChild(el);
  return { element: el, itemId: "1" };
}

function dispatchMouseEvent(el: Element, type: string, init: MouseEventInit = {}): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init }));
}

let handle: HoverHandle | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useFakeTimers();
});

afterEach(() => {
  handle?.destroy();
  handle = null;
  vi.useRealTimers();
});

describe("createHover", () => {
  test("shift-hover triggers when Shift is held on mouseenter", () => {
    const onTrigger = vi.fn();
    const onCancel = vi.fn();
    handle = createHover({ preferences: DEFAULT_PREFS, onTrigger, onCancel });
    const detected = makeDetected();
    handle.attach(detected);

    dispatchMouseEvent(detected.element, "mouseenter", { shiftKey: true });
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  test("shift-hover does NOT trigger without Shift", () => {
    const onTrigger = vi.fn();
    const onCancel = vi.fn();
    handle = createHover({ preferences: DEFAULT_PREFS, onTrigger, onCancel });
    const detected = makeDetected();
    handle.attach(detected);

    dispatchMouseEvent(detected.element, "mouseenter", { shiftKey: false });
    expect(onTrigger).not.toHaveBeenCalled();
  });

  test("hover-delay triggers after hoverDelayMs", () => {
    const onTrigger = vi.fn();
    const onCancel = vi.fn();
    const prefs: Preferences = { ...DEFAULT_PREFS, triggerMode: "hover-delay", hoverDelayMs: 350 };
    handle = createHover({ preferences: prefs, onTrigger, onCancel });
    const detected = makeDetected();
    handle.attach(detected);

    dispatchMouseEvent(detected.element, "mouseenter");
    expect(onTrigger).not.toHaveBeenCalled();
    vi.advanceTimersByTime(349);
    expect(onTrigger).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  test("hover-delay cancels on mouseleave before timer fires", () => {
    const onTrigger = vi.fn();
    const onCancel = vi.fn();
    const prefs: Preferences = { ...DEFAULT_PREFS, triggerMode: "hover-delay", hoverDelayMs: 400 };
    handle = createHover({ preferences: prefs, onTrigger, onCancel });
    const detected = makeDetected();
    handle.attach(detected);

    dispatchMouseEvent(detected.element, "mouseenter");
    vi.advanceTimersByTime(200);
    dispatchMouseEvent(detected.element, "mouseleave");
    vi.advanceTimersByTime(500);
    expect(onTrigger).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  test("long-press triggers after 500ms of mousedown", () => {
    const onTrigger = vi.fn();
    const onCancel = vi.fn();
    const prefs: Preferences = { ...DEFAULT_PREFS, triggerMode: "long-press" };
    handle = createHover({ preferences: prefs, onTrigger, onCancel });
    const detected = makeDetected();
    handle.attach(detected);

    dispatchMouseEvent(detected.element, "mousedown");
    vi.advanceTimersByTime(499);
    expect(onTrigger).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  test("long-press cancels on early mouseup", () => {
    const onTrigger = vi.fn();
    const onCancel = vi.fn();
    const prefs: Preferences = { ...DEFAULT_PREFS, triggerMode: "long-press" };
    handle = createHover({ preferences: prefs, onTrigger, onCancel });
    const detected = makeDetected();
    handle.attach(detected);

    dispatchMouseEvent(detected.element, "mousedown");
    vi.advanceTimersByTime(200);
    dispatchMouseEvent(detected.element, "mouseup");
    vi.advanceTimersByTime(1000);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  test("long-press cancels on mouseleave", () => {
    const onTrigger = vi.fn();
    const onCancel = vi.fn();
    const prefs: Preferences = { ...DEFAULT_PREFS, triggerMode: "long-press" };
    handle = createHover({ preferences: prefs, onTrigger, onCancel });
    const detected = makeDetected();
    handle.attach(detected);

    dispatchMouseEvent(detected.element, "mousedown");
    vi.advanceTimersByTime(100);
    dispatchMouseEvent(detected.element, "mouseleave");
    vi.advanceTimersByTime(1000);
    expect(onTrigger).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });

  test("updatePreferences switches mode without reattaching", () => {
    const onTrigger = vi.fn();
    const onCancel = vi.fn();
    handle = createHover({ preferences: DEFAULT_PREFS, onTrigger, onCancel });
    const detected = makeDetected();
    handle.attach(detected);

    // Shift-hover initially — entering without shift does nothing.
    dispatchMouseEvent(detected.element, "mouseenter", { shiftKey: false });
    expect(onTrigger).not.toHaveBeenCalled();
    dispatchMouseEvent(detected.element, "mouseleave");

    // Hot-swap to long-press; same element should now respond to mousedown.
    handle.updatePreferences({ ...DEFAULT_PREFS, triggerMode: "long-press" });
    dispatchMouseEvent(detected.element, "mousedown");
    vi.advanceTimersByTime(500);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  test("destroy() detaches all element listeners", () => {
    const onTrigger = vi.fn();
    const onCancel = vi.fn();
    handle = createHover({ preferences: DEFAULT_PREFS, onTrigger, onCancel });
    const detected = makeDetected();
    handle.attach(detected);
    handle.destroy();

    dispatchMouseEvent(detected.element, "mouseenter", { shiftKey: true });
    expect(onTrigger).not.toHaveBeenCalled();
  });
});
