import { __resetPopupMountForTests, getOrCreatePopupMount } from "@/content/popup/popup-mount";
import { createElement } from "react";
/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// jsdom doesn't measure layout, so getBoundingClientRect on the React host
// returns zeros. The mount uses a 320×160 fallback in that case, which is
// what we assert against here.
const FALLBACK_W = 320;
const FALLBACK_H = 160;

function setViewport(w: number, h: number): void {
  Object.defineProperty(window, "innerWidth", { value: w, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: h, configurable: true, writable: true });
}

function rect(x: number, y: number, width = 80, height = 20): DOMRect {
  return {
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON() {
      return this;
    },
  } as DOMRect;
}

beforeEach(() => {
  document.body.innerHTML = "";
  __resetPopupMountForTests();
  setViewport(1280, 800);
});

afterEach(() => {
  __resetPopupMountForTests();
  vi.useRealTimers();
});

describe("popup-mount", () => {
  test("flips below when anchor is near top of viewport", () => {
    const mount = getOrCreatePopupMount();
    mount.anchor(rect(100, 10));
    const host = document.getElementById("nsl-popup-host");
    expect(host).not.toBeNull();
    const top = Number.parseInt(host?.style.top ?? "0", 10);
    // Anchor at y=10 with height 20 -> bottom = 30. Below gets 6px padding.
    expect(top).toBeGreaterThanOrEqual(30);
    // Should NOT be flipped above (which would require negative top relative
    // to the anchor or near the top margin).
    expect(top).toBeGreaterThanOrEqual(8);
  });

  test("flips above when anchor is near bottom of viewport", () => {
    const mount = getOrCreatePopupMount();
    // 800 viewport. Anchor at y=780 with height 20 -> bottom = 800, no
    // room below (0 px). Popup needs to land above.
    mount.anchor(rect(100, 780));
    const host = document.getElementById("nsl-popup-host");
    const top = Number.parseInt(host?.style.top ?? "0", 10);
    // Above: rect.top - popupH - 6 = 780 - 160 - 6 = 614.
    expect(top).toBeLessThan(780);
    expect(top).toBe(780 - FALLBACK_H - 6);
  });

  test("clamps to right edge when anchor is far right", () => {
    const mount = getOrCreatePopupMount();
    // Anchor at right side of 1280-wide viewport.
    mount.anchor(rect(1240, 100, 30, 20));
    const host = document.getElementById("nsl-popup-host");
    const left = Number.parseInt(host?.style.left ?? "0", 10);
    // left + popupW must fit in viewport with 8px margin.
    expect(left + FALLBACK_W).toBeLessThanOrEqual(1280 - 8 + 1);
  });

  test("click outside triggers onClose handler from rendered node", () => {
    const mount = getOrCreatePopupMount();
    const onClose = vi.fn();
    mount.anchor(rect(100, 100));
    mount.render(createElement("div", { onClose }, "test"));

    // Click on document.body (not inside the host).
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onClose).toHaveBeenCalled();
  });

  test("Escape key triggers onClose handler", () => {
    const mount = getOrCreatePopupMount();
    const onClose = vi.fn();
    mount.anchor(rect(100, 100));
    mount.render(createElement("div", { onClose }, "test"));

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalled();
  });

  // Builds a fake NetSuite Popover with the chrome wrapper our inject path
  // expects (arrow + content wrapper). Both wrappers get a non-zero bounding
  // rect so the chrome-detection heuristic in injectIntoQv finds the right
  // child.
  function makeFakeQv(): { quickview: HTMLDivElement; chrome: HTMLDivElement } {
    const quickview = document.createElement("div");
    quickview.setAttribute("data-widget", "Popover");
    quickview.setAttribute("role", "tooltip");
    const arrow = document.createElement("div");
    Object.defineProperty(arrow, "getBoundingClientRect", {
      value: () =>
        ({
          x: 0,
          y: 0,
          width: 14,
          height: 14,
          top: 0,
          left: 0,
          right: 14,
          bottom: 14,
          toJSON() {
            return this;
          },
        }) as DOMRect,
    });
    const chrome = document.createElement("div");
    Object.defineProperty(chrome, "getBoundingClientRect", {
      value: () =>
        ({
          x: 200,
          y: 150,
          width: 320,
          height: 280,
          top: 150,
          left: 200,
          right: 520,
          bottom: 430,
          toJSON() {
            return this;
          },
        }) as DOMRect,
    });
    const windowBody = document.createElement("div");
    windowBody.setAttribute("data-widget", "WindowBody");
    chrome.appendChild(windowBody);
    quickview.appendChild(arrow);
    quickview.appendChild(chrome);
    Object.defineProperty(quickview, "getBoundingClientRect", {
      value: () =>
        ({
          x: 200,
          y: 150,
          width: 320,
          height: 280,
          top: 150,
          left: 200,
          right: 520,
          bottom: 430,
          toJSON() {
            return this;
          },
        }) as DOMRect,
    });
    document.body.appendChild(quickview);
    return { quickview, chrome };
  }

  test("embeds inside NetSuite's native QuickView when one is present", () => {
    const { quickview } = makeFakeQv();
    const mount = getOrCreatePopupMount();
    mount.anchor(rect(180, 160));

    // Standalone host is hidden — content lives inside the QV now.
    const host = document.getElementById("nsl-popup-host");
    expect(host).not.toBeNull();
    expect(host?.style.display).toBe("none");

    // The injected shadow host was appended as a direct child of the QV
    // (sibling of the chrome wrapper), and the Popover itself is flipped
    // to row so the two columns sit side by side.
    const injected = quickview.querySelector('[data-nsl-injected="true"]');
    expect(injected).not.toBeNull();
    expect(injected?.shadowRoot).not.toBeNull();
    expect(injected?.parentElement).toBe(quickview);
    expect(quickview.style.flexDirection).toBe("row");

    quickview.remove();
  });

  test("closes via onClose when the native QuickView is removed", async () => {
    const { quickview } = makeFakeQv();
    const mount = getOrCreatePopupMount();
    const onClose = vi.fn();
    mount.anchor(rect(180, 160));
    mount.render(createElement("div", { onClose }, "test"));
    expect(quickview.querySelector('[data-nsl-injected="true"]')).not.toBeNull();

    quickview.remove();
    // MutationObserver fires asynchronously; flush microtasks.
    await new Promise((r) => setTimeout(r, 0));
    expect(onClose).toHaveBeenCalled();
  });

  test("falls back to a plain <div> host when customElements is null", () => {
    // Observed on NetSuite's Classic dashboard: `window.customElements`
    // appears as `null`. The mount must still work in that environment.
    const original = globalThis.customElements;
    Object.defineProperty(globalThis, "customElements", {
      configurable: true,
      value: null,
    });
    try {
      const mount = getOrCreatePopupMount();
      mount.anchor(rect(100, 100));
      // No throw is the primary assertion. The host element exists in the DOM
      // and is a plain <div>, not the <nsl-host> custom element.
      const host = document.getElementById("nsl-popup-host");
      expect(host).not.toBeNull();
      expect(host?.tagName).toBe("DIV");
    } finally {
      Object.defineProperty(globalThis, "customElements", {
        configurable: true,
        value: original,
      });
    }
  });

  test("re-injects when NetSuite swaps the QV element in one mutation batch", async () => {
    const first = makeFakeQv();
    const mount = getOrCreatePopupMount();
    const onClose = vi.fn();
    mount.anchor(rect(180, 160));
    mount.render(createElement("div", { onClose }, "first"));
    expect(first.quickview.querySelector('[data-nsl-injected="true"]')).not.toBeNull();

    // Simulate NetSuite's swap: remove the old Popover and add a new one
    // in the same task tick. The MutationObserver should fire once with
    // both mutations, the orphaned injection should be reconciled, and a
    // fresh inject should land inside the replacement QV without
    // notifying onClose (the popup's lifecycle continues seamlessly).
    first.quickview.remove();
    const second = makeFakeQv();
    await new Promise((r) => setTimeout(r, 0));

    expect(onClose).not.toHaveBeenCalled();
    expect(second.quickview.querySelector('[data-nsl-injected="true"]')).not.toBeNull();
    expect(mount.isOpen()).toBe(true);
    expect(mount.isInjected()).toBe(true);

    second.quickview.remove();
  });

  test("hide() clears open state and ignores subsequent close events", () => {
    const mount = getOrCreatePopupMount();
    const onClose = vi.fn();
    mount.anchor(rect(100, 100));
    mount.render(createElement("div", { onClose }, "test"));
    expect(mount.isOpen()).toBe(true);
    mount.hide();
    expect(mount.isOpen()).toBe(false);

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
