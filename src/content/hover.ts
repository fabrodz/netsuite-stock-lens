import type { DetectedItem } from "@/content/detection";
/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import type { Preferences } from "@/lib/preferences";

// Hover handler abstraction over the three configurable trigger modes:
// shift-hover (default), hover-delay, and long-press.
//
// One handle is created per page; each detected element is attached via
// `attach()`, which returns a detach function bound to an AbortController so
// cleanup is a single signal abort. `updatePreferences()` rotates the
// current snapshot but does NOT cancel in-flight timers — finishing a
// long-press the user already started feels less surprising than abruptly
// dropping the popup when prefs change. New `mouseenter`/`mousedown` events
// after the update obey the new mode.

export interface HoverTriggerOptions {
  preferences: Preferences;
  onTrigger(detected: DetectedItem, anchor: HTMLElement, mouseEvent: MouseEvent): void;
  onCancel(): void;
}

export interface HoverHandle {
  attach(detected: DetectedItem): () => void;
  updatePreferences(next: Preferences): void;
  destroy(): void;
}

const LONG_PRESS_MS = 500;

export function createHover(opts: HoverTriggerOptions): HoverHandle {
  let prefs = opts.preferences;
  const attachments = new Set<AbortController>();

  function attach(detected: DetectedItem): () => void {
    const el = detected.element;
    const controller = new AbortController();
    const signal = controller.signal;
    attachments.add(controller);

    // Each attach has its own timer slot. Storing it on the closure keeps
    // detach simple (controller.abort handles listener removal; we just need
    // to clear the timer to stop the trigger from firing late).
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    function clearPending(): void {
      if (pendingTimer !== null) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
    }

    function onEnter(event: MouseEvent): void {
      const mode = prefs.triggerMode;
      if (mode === "shift-hover") {
        if (event.shiftKey) {
          opts.onTrigger(detected, el, event);
        }
        return;
      }
      if (mode === "hover-delay") {
        clearPending();
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          opts.onTrigger(detected, el, event);
        }, prefs.hoverDelayMs);
        return;
      }
      // long-press waits for mousedown, not mouseenter.
    }

    function onLeave(): void {
      clearPending();
      opts.onCancel();
    }

    function onDown(event: MouseEvent): void {
      if (prefs.triggerMode !== "long-press") return;
      clearPending();
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        opts.onTrigger(detected, el, event);
      }, LONG_PRESS_MS);
    }

    function onUp(): void {
      if (prefs.triggerMode !== "long-press") return;
      // mouseup without firing means the user released early; cancel the
      // pending trigger. If the trigger already fired, the popup is already
      // open and onCancel is the wrong signal — only call it on the cancel
      // path.
      if (pendingTimer !== null) {
        clearPending();
      }
    }

    el.addEventListener("mouseenter", onEnter, { signal });
    el.addEventListener("mouseleave", onLeave, { signal });
    el.addEventListener("mousedown", onDown, { signal });
    el.addEventListener("mouseup", onUp, { signal });

    signal.addEventListener("abort", () => {
      clearPending();
      attachments.delete(controller);
    });

    return () => {
      controller.abort();
    };
  }

  return {
    attach,
    updatePreferences(next) {
      // Mutate the snapshot in place. In-flight timers keep their previous
      // delay because cancelling them mid-press would feel jumpy; the
      // trade-off is documented in the module header.
      prefs = next;
    },
    destroy() {
      for (const controller of attachments) {
        controller.abort();
      }
      attachments.clear();
    },
  };
}
