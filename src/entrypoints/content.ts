import { setupBridge } from "@/content/bridge";
import { type DetectedItem, type DetectionHandle, startDetection } from "@/content/detection";
import { type HoverHandle, createHover } from "@/content/hover";
import { HoverPopup } from "@/content/popup/HoverPopup";
import { type PopupMount, getOrCreatePopupMount } from "@/content/popup/popup-mount";
import { type PrefetchHandle, startPrefetch } from "@/content/prefetch";
import { parseAccountId } from "@/lib/accountId";
import {
  DEFAULT_PREFERENCES,
  type Preferences,
  getPreferences,
  onPreferencesChanged,
} from "@/lib/preferences";
import { isListViewSurface, parseCurrentTransactionId, urlToSurface } from "@/lib/surfaces";
/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { createElement } from "react";

// SPA-aware navigation: NetSuite often replaces URLs without a full reload.
// We monkey-patch pushState/replaceState (popstate already fires for back/
// forward) and emit a single `nsl:location-change` event that the wiring
// layer listens to. We do NOT touch history itself; the goal is observation.
const LOCATION_EVENT = "nsl:location-change";

function installLocationListener(): void {
  const w = window as unknown as { __nslHistoryPatched?: boolean };
  if (w.__nslHistoryPatched) return;
  w.__nslHistoryPatched = true;
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;
  history.pushState = function patchedPushState(
    ...args: Parameters<typeof originalPush>
  ): ReturnType<typeof originalPush> {
    const result = originalPush.apply(this, args);
    window.dispatchEvent(new CustomEvent(LOCATION_EVENT));
    return result;
  };
  history.replaceState = function patchedReplaceState(
    ...args: Parameters<typeof originalReplace>
  ): ReturnType<typeof originalReplace> {
    const result = originalReplace.apply(this, args);
    window.dispatchEvent(new CustomEvent(LOCATION_EVENT));
    return result;
  };
  window.addEventListener("popstate", () => {
    window.dispatchEvent(new CustomEvent(LOCATION_EVENT));
  });
}

interface ActiveWiring {
  detection: DetectionHandle;
  hover: HoverHandle;
  unsubscribeDetect: () => void;
  attachments: Map<HTMLElement, () => void>;
  // Prefetch state. Owned by the wiring so a surface change tears
  // it down with one `stopWiring()` call. All four fields are populated
  // only when the surface is a list view AND `prefetchEnabled` is true.
  prefetch: PrefetchState | null;
}

// Prefetch bookkeeping for one list-view surface.
//
// `detectedItemIds` is the running set of item IDs the MutationObserver
// has emitted via detection. We hold the IDs as an ordered Set so the
// "first N visible" semantic is stable across paginations: the prefetch
// dequeues from the start of the set in detection order, which on initial
// page load matches the visual top-of-list. After a re-pagination the
// observer emits new IDs that join the back of the set; we only prefetch
// the first N regardless, so users see warm data above the fold.
interface PrefetchState {
  detectedItemIds: Set<string>;
  // Pending idle timer. Reset on every user-input event; when it fires we
  // kick off the prefetch.
  idleTimer: ReturnType<typeof setTimeout> | null;
  // Most recent prefetch handle (or null if none running). We track it so
  // a location change can abort an in-flight prefetch even when the user
  // doesn't trigger another idle reset.
  active: PrefetchHandle | null;
  // Cleanup function returned by `installPrefetchIdleListeners`. Tears
  // down the mousemove/mousedown listeners and the timer.
  destroy: () => void;
}

// 200 ms grace lets the user move from the anchor into the popup without it
// disappearing under the cursor. A second hover cancels the pending hide.
const CLOSE_GRACE_MS = 200;

// Smart prefetch: how long the user must be idle on a list view
// surface before we start warming the cache. 3 s is the design
// default — long enough that a user scrolling/searching doesn't churn
// prefetches, short enough that someone reading the list has the data
// ready when they finally hover.
const PREFETCH_IDLE_MS = 3000;
// Fixed concurrency cap: never run more than 3 SuiteQL fetches in
// parallel. NetSuite SuiteQL has a documented ~10-connection-per-role
// limit; staying well below keeps us out of throttling.
const PREFETCH_CONCURRENCY = 3;

export default defineContentScript({
  matches: ["*://*.netsuite.com/*", "*://*.app.netsuite.com/*", "*://*.suiteapp.com/*"],
  runAt: "document_idle",
  async main(ctx) {
    setupBridge();
    installLocationListener();

    const accountId = parseAccountId(window.location.hostname);
    if (accountId === null) {
      // Not a NetSuite account host (e.g. system.netsuite.com login page).
      // Nothing to wire; the bridge stays inert.
      return;
    }

    const popupMount: PopupMount = getOrCreatePopupMount();
    let prefs: Preferences;
    try {
      prefs = await getPreferences();
    } catch (err) {
      console.warn("[nsl] failed to load preferences, using defaults", err);
      prefs = { ...DEFAULT_PREFERENCES };
    }

    let wiring: ActiveWiring | null = null;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;

    function cancelCloseTimer(): void {
      if (closeTimer !== null) {
        clearTimeout(closeTimer);
        closeTimer = null;
      }
    }

    function hidePopupSoon(): void {
      // When our content lives inside NetSuite's native QuickView, the
      // QV owns the lifecycle: moving the cursor from the trigger link
      // into the QV body fires mouseleave on the link but is a normal
      // read interaction, not a dismiss. The QV's MutationObserver inside
      // popup-mount tears our content down when NetSuite removes the QV.
      if (popupMount.isInjected()) return;
      cancelCloseTimer();
      closeTimer = setTimeout(() => {
        closeTimer = null;
        popupMount.hide();
      }, CLOSE_GRACE_MS);
    }

    function hidePopupNow(): void {
      cancelCloseTimer();
      popupMount.hide();
    }

    function triggerPopup(detected: DetectedItem, anchor: HTMLElement, _event: MouseEvent): void {
      cancelCloseTimer();
      const rect = anchor.getBoundingClientRect();
      popupMount.anchor(rect, anchor);
      // On PO and Transfer Order surfaces we want the "Next
      // receipt" list to exclude the current record (a PO viewing itself
      // shouldn't list itself as an incoming receipt). We re-read the URL
      // here rather than caching at wiring time so back/forward navigation
      // inside the SPA picks up the new id without re-wiring.
      const currentSurface = urlToSurface(window.location.href);
      const excludeTrxId =
        currentSurface === "purchase-order" || currentSurface === "transfer-order"
          ? (parseCurrentTransactionId(window.location.href) ?? undefined)
          : undefined;
      // List-view surfaces (saved search results, item lists,
      // reports) lack per-line context. The popup hides the badge and
      // skips the lineQty DOM walk in this mode.
      const listViewMode = currentSurface !== null && isListViewSurface(currentSurface);
      popupMount.render(
        createElement(HoverPopup, {
          itemId: detected.itemId,
          accountId: accountId as string,
          // Anchor is passed so the popup can walk up to the line
          // row and read the line quantity for the status badge.
          anchor,
          excludeTrxId,
          listViewMode,
          onClose: hidePopupNow,
        }),
      );
    }

    function startWiring(currentPrefs: Preferences): ActiveWiring {
      const detection = startDetection();
      const hover = createHover({
        preferences: currentPrefs,
        onTrigger: triggerPopup,
        onCancel: hidePopupSoon,
      });
      const attachments = new Map<HTMLElement, () => void>();

      // When the surface is a list view AND prefetch is enabled,
      // set up the idle-based smart prefetch. We attach a separate
      // detection listener (not unsubscribed by `unsubscribeDetect`) that
      // collects item IDs into the prefetch state — keeping it as a
      // sibling subscription keeps the hover wiring's failure path
      // simple, and a single `detection.destroy()` in `stopWiring` cleans
      // both up.
      const surface = urlToSurface(window.location.href);
      const listView = surface !== null && isListViewSurface(surface);
      const prefetch: PrefetchState | null =
        listView && currentPrefs.prefetchEnabled
          ? createPrefetchState(detection, currentPrefs)
          : null;

      const unsubscribeDetect = detection.onDetect((detected) => {
        if (attachments.has(detected.element)) return;
        const detach = hover.attach(detected);
        attachments.set(detected.element, detach);
      });

      return { detection, hover, unsubscribeDetect, attachments, prefetch };
    }

    // Constructs the prefetch state and starts watching for user idle.
    // Detection emits every visible item link; we collect IDs into a Set
    // and arm a single 3 s idle timer. Any mousemove/mousedown resets the
    // timer (a user actively scanning the list shouldn't lose CPU to a
    // prefetch). When the timer fires we slice the first N items off the
    // set and hand them to `startPrefetch`.
    function createPrefetchState(
      detection: DetectionHandle,
      currentPrefs: Preferences,
    ): PrefetchState {
      const state: PrefetchState = {
        detectedItemIds: new Set(),
        idleTimer: null,
        active: null,
        destroy: () => undefined,
      };

      function clearIdleTimer(): void {
        if (state.idleTimer !== null) {
          clearTimeout(state.idleTimer);
          state.idleTimer = null;
        }
      }

      function armIdleTimer(): void {
        clearIdleTimer();
        state.idleTimer = setTimeout(() => {
          state.idleTimer = null;
          // Snapshot the first N items in detection order. We don't
          // dedupe against the cache here — a warm L1 lookup is cheap,
          // and the bridge call only happens on a true miss.
          const items = Array.from(state.detectedItemIds).slice(0, currentPrefs.prefetchN);
          if (items.length === 0) return;
          // Abort any previous prefetch that's still running. Two
          // overlapping prefetches don't share work and would double the
          // SuiteQL load; one at a time is enough.
          state.active?.abort();
          const controller = new AbortController();
          const handle = startPrefetch({
            accountId: accountId as string,
            itemIds: items,
            concurrency: PREFETCH_CONCURRENCY,
            signal: controller.signal,
          });
          // Wire the controller into the handle so an external abort
          // also short-circuits the queue. `startPrefetch` derives its
          // own child signal from our controller's signal.
          state.active = {
            promise: handle.promise,
            abort: () => {
              if (!controller.signal.aborted) {
                controller.abort(new DOMException("prefetch-abort", "AbortError"));
              }
              handle.abort();
            },
          };
          // We don't await the prefetch; the popup reads the cache
          // synchronously on the next hover.
          handle.promise.catch(() => {
            // Prefetch is best-effort; per-item failures fold into the
            // summary and the promise never rejects, but defensive catch
            // keeps an exception from accidentally bubbling to the
            // window's unhandledrejection handler.
          });
        }, PREFETCH_IDLE_MS);
      }

      // Listener for user input. Any mousemove or mousedown resets the
      // idle timer; we don't listen for key events because list-view
      // navigation tends to be mouse-driven and we'd rather under-
      // prefetch than over-cancel.
      const onActivity = (): void => {
        armIdleTimer();
      };
      document.addEventListener("mousemove", onActivity, { passive: true });
      document.addEventListener("mousedown", onActivity, { passive: true });

      // Collect detected item IDs. We attach AFTER the hover listener
      // above so the order doesn't matter; the WeakMap dedup in
      // detection ensures we don't see the same element twice.
      const unsubscribeCollect = detection.onDetect((detected) => {
        state.detectedItemIds.add(detected.itemId);
      });

      // Initial arm — even with zero detected items yet, the timer
      // arms so as detection populates we get the first prefetch.
      armIdleTimer();

      state.destroy = () => {
        clearIdleTimer();
        state.active?.abort();
        state.active = null;
        document.removeEventListener("mousemove", onActivity);
        document.removeEventListener("mousedown", onActivity);
        unsubscribeCollect();
      };

      return state;
    }

    function stopWiring(): void {
      if (!wiring) return;
      wiring.unsubscribeDetect();
      for (const detach of wiring.attachments.values()) detach();
      wiring.attachments.clear();
      wiring.hover.destroy();
      wiring.detection.destroy();
      wiring.prefetch?.destroy();
      hidePopupNow();
      wiring = null;
    }

    function evaluateSurface(currentPrefs: Preferences): void {
      const surface = urlToSurface(window.location.href);
      const shouldRun = surface !== null && currentPrefs.enabled;
      if (shouldRun && !wiring) {
        wiring = startWiring(currentPrefs);
      } else if (!shouldRun && wiring) {
        stopWiring();
      }
    }

    evaluateSurface(prefs);

    // Preferences changes: hot-reload mode without re-attaching, or fully
    // start/stop wiring when `enabled` flips.
    const unsubscribePrefs = onPreferencesChanged((next, previous) => {
      prefs = next;
      const enabledChanged = next.enabled !== previous.enabled;
      if (enabledChanged) {
        evaluateSurface(next);
        return;
      }
      if (wiring) {
        wiring.hover.updatePreferences(next);
      }
    });

    // SPA navigation: re-evaluate the surface. Tearing down on every
    // location change keeps the popup honest — a Sales Order can navigate
    // to a Vendor record, and we only support SO + Quote here.
    // Tearing down via `evaluateSurface -> stopWiring` cancels
    // any in-flight prefetch via `prefetch.destroy()`; we don't need a
    // separate location-change handler for prefetch cancellation.
    const onLocationChange = (): void => {
      evaluateSurface(prefs);
    };
    window.addEventListener(LOCATION_EVENT, onLocationChange);

    // Cleanup on extension reload / context invalidation. The WXT ctx
    // surface for invalidation isn't typed in our resolved declarations, so
    // we fall through to defensive cleanup via teardown helpers.
    const c = ctx as { onInvalidated?: (cb: () => void) => void };
    c.onInvalidated?.(() => {
      window.removeEventListener(LOCATION_EVENT, onLocationChange);
      unsubscribePrefs();
      stopWiring();
    });
  },
});
