/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Item-link detection for transaction surfaces.
//
// Three cascading strategies, applied in priority order to each element so a
// link doesn't fire twice from two strategies:
//   1. URL pattern — anchors that point at /app/common/item/item.nl?id=NNN.
//      Strongest signal; the id is in the href. This same strategy also
//      handles item links rendered inside report `<td>` cells and list-view
//      tables — the selector below looks at any `<a href>` regardless of
//      ancestor, so reports/lists/saved searches all reuse this path with no
//      extra logic.
//   2. data-itemid — elements explicitly tagged by NetSuite (or by us in
//      with a numeric item id attribute.
//   3. DOM fallback — transaction-line table rows that carry a hidden input
//      named like `item`, `item1`, `item2`... or with id `inpt_itemN_M`.
//      NetSuite renders these alongside the visible label so the user can
//      hover the whole cell, not just the link. Heuristic: walk up from the
//      hidden input to the closest table row/cell and treat that as the
//      hoverable element. Limited to single-digit field suffixes initially
//      (covers `item`, `item1`..`item9`); higher-arity fields handled separately
//      when we have a broader corpus of real DOM samples.
//
// Dedup: a WeakMap of already-emitted elements ensures the same DetectedItem
// is never dispatched twice. The WeakMap is cleared implicitly when the
// element is garbage-collected after removal from the DOM.
//
// List-view additions:
//   - Header / summary / role="rowheader" rows are excluded from the hidden-
//     input strategy. NetSuite re-uses the same <tr> shape for header rows in
//     list views; emitting a detection there would attach hover handlers to a
//     non-data row.
//   - Pagination handling: NetSuite list views re-render the result table on
//     page change. The existing MutationObserver picks up the new rows on its
//     own, but list views also expose a page picker (anchor with
//     `id^="pagepicker"` or input named "pagepicker"). When that element
//     changes we trigger an explicit forced re-scan ~500 ms later — the
//     re-render isn't always synchronous after the page-picker click, so
//     waiting one frame is unreliable.
//   - `nsl:location-change` listener: the SPA-navigation hook in
//     entrypoints/content.ts dispatches this event on history pushState /
//     replaceState / popstate. Detection clears its WeakMap and re-scans the
//     root so a navigation that swaps the same anchor element for a new item
//     id doesn't silently miss the new id.

export interface DetectedItem {
  element: HTMLElement; // anchor or container the user hovers
  itemId: string; // numeric NetSuite internal ID, kept as string for safety
}

export interface DetectionHandle {
  // Called whenever a new item link is detected (initial scan or DOM change).
  // The same element will not be reported twice.
  onDetect(listener: (detected: DetectedItem) => void): () => void;
  // Stops the MutationObserver and clears listeners.
  destroy(): void;
}

const ITEM_URL_PATH = "/app/common/item/item.nl";
const HIDDEN_ITEM_INPUT_NAME = /^item\d?$/;
const HIDDEN_ITEM_INPUT_ID = /^inpt_item\d+_\d+$/;
// Class names NetSuite uses for header / summary / total rows in classic
// list views. We skip these because they aren't user-actionable lines and
// emitting a detection for them would attach hover handlers to chrome rows.
const SKIPPED_ROW_CLASSES: ReadonlyArray<string> = ["uir-list-row-tr--header", "uir-row-summary"];
// CSS selector that matches both NetSuite's classic page picker anchors and
// the Redwood pagination input. Either one changing is a strong signal that
// the result table is about to re-render.
const PAGE_PICKER_SELECTOR = "a[id^='pagepicker'], input[name='pagepicker']";
const PAGINATION_RESCAN_DELAY_MS = 500;
const LOCATION_CHANGE_EVENT = "nsl:location-change";

function extractFromAnchor(anchor: HTMLAnchorElement): string | null {
  // Parse the href via URL so we handle relative paths and arbitrary query
  // ordering robustly. Regex on the raw href misses encoded ampersands and
  // unusual orderings.
  let parsed: URL;
  try {
    parsed = new URL(anchor.href, window.location.origin);
  } catch {
    return null;
  }
  if (!parsed.pathname.includes(ITEM_URL_PATH)) return null;
  const id = parsed.searchParams.get("id");
  if (id === null) return null;
  if (!/^\d+$/.test(id)) return null;
  return id;
}

function extractFromDataAttr(element: HTMLElement): string | null {
  const raw = element.dataset.itemid;
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;
  return raw;
}

// Returns true if the row is a header / summary / total row that should NOT
// produce a detection. Heuristics:
//   - inside <thead>
//   - role="rowheader" on the row itself
//   - classic NetSuite header / summary class names
function isSkippedRow(row: Element | null): boolean {
  if (row === null) return false;
  if (row.parentElement?.nodeName === "THEAD") return true;
  if (row.getAttribute("role") === "rowheader") return true;
  for (const cls of SKIPPED_ROW_CLASSES) {
    if (row.classList.contains(cls)) return true;
  }
  return false;
}

function extractFromHiddenInput(input: HTMLInputElement): {
  itemId: string;
  container: HTMLElement;
} | null {
  const name = input.getAttribute("name") ?? "";
  const id = input.getAttribute("id") ?? "";
  const nameMatch = HIDDEN_ITEM_INPUT_NAME.test(name);
  const idMatch = HIDDEN_ITEM_INPUT_ID.test(id);
  if (!nameMatch && !idMatch) return null;
  const value = input.value?.trim();
  if (!value || !/^\d+$/.test(value)) return null;
  // Attach to the closest row so the user can hover anywhere on the line,
  // not just on the link. Falls back to the input's parent cell, then to the
  // input itself if nothing better exists.
  const row = input.closest("tr") ?? input.closest("td") ?? input.parentElement ?? input;
  // Skip header / summary rows: NetSuite re-uses the <tr> shape for chrome
  // rows in list views, and attaching a hover detection there would attach
  // handlers to non-data rows.
  if (isSkippedRow(row instanceof Element ? row : null)) return null;
  return { itemId: value, container: row as HTMLElement };
}

interface DetectionInternal {
  emitted: WeakMap<HTMLElement, true>;
  listeners: Set<(detected: DetectedItem) => void>;
}

function emit(state: DetectionInternal, detected: DetectedItem): void {
  if (state.emitted.has(detected.element)) return;
  state.emitted.set(detected.element, true);
  for (const listener of state.listeners) {
    try {
      listener(detected);
    } catch (err) {
      // A failing listener shouldn't poison the dispatch loop for siblings.
      console.error("[nsl] detection listener threw", err);
    }
  }
}

function scanElement(state: DetectionInternal, element: Element): void {
  if (!(element instanceof HTMLElement)) return;

  // Strategy 1: the element itself is a matching anchor.
  if (element instanceof HTMLAnchorElement) {
    // Skip anchors inside header rows: a "Item" column header may itself be
    // an anchor (sortable column) but it isn't a data row.
    const ownerRow = element.closest("tr");
    if (isSkippedRow(ownerRow)) return;
    const id = extractFromAnchor(element);
    if (id !== null) {
      emit(state, { element, itemId: id });
      return;
    }
  }

  // Strategy 2: the element itself carries data-itemid.
  if (element.dataset.itemid !== undefined) {
    const id = extractFromDataAttr(element);
    if (id !== null) {
      emit(state, { element, itemId: id });
      // Don't return — an inner anchor with a different id is conceptually
      // a separate detection. But we keep things simple: a
      // single element gets one detection at most. Continue to children
      // via the subtree scan below.
    }
  }

  // Strategy 3 (hidden item inputs) is handled by scanSubtree via the
  // descendant query — it has no per-element analogue here.
}

function scanSubtree(state: DetectionInternal, root: ParentNode): void {
  // Strategy 1 — every matching anchor in the subtree. We skip anchors
  // inside header rows so a sortable column anchor in a list view doesn't
  // get treated as an item link.
  const anchors = root.querySelectorAll<HTMLAnchorElement>(`a[href*="${ITEM_URL_PATH}"]`);
  for (const anchor of anchors) {
    const ownerRow = anchor.closest("tr");
    if (isSkippedRow(ownerRow)) continue;
    const id = extractFromAnchor(anchor);
    if (id !== null) {
      emit(state, { element: anchor, itemId: id });
    }
  }

  // Strategy 2 — any element flagged with data-itemid.
  const tagged = root.querySelectorAll<HTMLElement>("[data-itemid]");
  for (const el of tagged) {
    const id = extractFromDataAttr(el);
    if (id !== null) {
      emit(state, { element: el, itemId: id });
    }
  }

  // Strategy 3 — hidden inputs identifying transaction lines.
  const inputs = root.querySelectorAll<HTMLInputElement>("input[type='hidden'], input");
  for (const input of inputs) {
    const found = extractFromHiddenInput(input);
    if (found !== null) {
      emit(state, { element: found.container, itemId: found.itemId });
    }
  }

  // Allow the root itself to count (querySelectorAll skips the root).
  if (root instanceof Element) {
    scanElement(state, root);
  }
}

type IdleScheduler = (cb: () => void) => void;

function pickIdleScheduler(): IdleScheduler {
  // requestIdleCallback isn't on the standard `window` typings in our TS
  // libs, so we narrow via runtime check. Fallback keeps tests deterministic
  // without forcing a polyfill.
  const w = window as unknown as {
    requestIdleCallback?: (cb: () => void) => number;
  };
  if (typeof w.requestIdleCallback === "function") {
    return (cb: () => void) => {
      w.requestIdleCallback?.(cb);
    };
  }
  return (cb: () => void) => {
    setTimeout(cb, 0);
  };
}

export function startDetection(root: ParentNode = document.body): DetectionHandle {
  const state: DetectionInternal = {
    emitted: new WeakMap(),
    listeners: new Set(),
  };

  const schedule = pickIdleScheduler();
  let scanQueued = false;
  function queueScan(target: ParentNode): void {
    // Batch a flurry of DOM updates into a single scan. We rescan the root
    // because individual MutationRecord targets aren't always the right
    // entry point (a detached subtree can be re-attached).
    if (scanQueued) return;
    scanQueued = true;
    schedule(() => {
      scanQueued = false;
      scanSubtree(state, target);
    });
  }

  // Initial scan: defer one frame so any synchronous post-load DOM tweaks
  // settle before we read.
  function initialScan(): void {
    requestAnimationFrame(() => {
      scanSubtree(state, root);
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialScan, { once: true });
  } else {
    initialScan();
  }

  // Track the current page-picker element (or its serialised value) so a
  // mutation on the picker triggers a forced re-scan after a short delay.
  // The delay exists because the result table doesn't re-render
  // synchronously after a page click — NetSuite issues an XHR and rebuilds
  // <tbody> when the response arrives. 500 ms covers most cases without
  // adding noticeable latency for the user.
  let paginationTimer: ReturnType<typeof setTimeout> | null = null;
  function schedulePaginationRescan(): void {
    if (paginationTimer !== null) clearTimeout(paginationTimer);
    paginationTimer = setTimeout(() => {
      paginationTimer = null;
      // A full re-scan: the new page rows weren't in the DOM when the
      // MutationObserver fired, and even if they were, the WeakMap already
      // has stale entries from the previous page.
      scanSubtree(state, root);
    }, PAGINATION_RESCAN_DELAY_MS);
  }

  function snapshotPagePicker(): string {
    const node = (root instanceof Document ? root : document).querySelector(PAGE_PICKER_SELECTOR);
    if (node === null) return "";
    // Combine the visible state (value attr for input, textContent for an
    // anchor's label, plus the data attribute NetSuite stores the page
    // number in) so we detect any change in the picker.
    const text = (node.textContent ?? "").trim();
    const value =
      node instanceof HTMLInputElement ? node.value : (node.getAttribute("value") ?? "");
    const data = node.getAttribute("data-pageindex") ?? "";
    return `${text}|${value}|${data}`;
  }

  let lastPagePickerSnapshot = snapshotPagePicker();

  const observer = new MutationObserver((records) => {
    let touched = false;
    for (const record of records) {
      if (record.type === "attributes" && record.attributeName === "data-itemid") {
        touched = true;
      } else if (record.addedNodes.length > 0) {
        touched = true;
      }
      // Removed nodes: the WeakMap entry for a detached element will be
      // cleared by GC. We don't actively prune because no functional bug
      // results from a stale entry (the element isn't reachable to hover).
    }
    if (touched) queueScan(root);

    // Pagination check is decoupled from the queueScan path: even if no
    // children were added (the picker may update before the result-row
    // re-render), we still want to schedule a forced re-scan.
    const currentSnapshot = snapshotPagePicker();
    if (currentSnapshot !== lastPagePickerSnapshot) {
      lastPagePickerSnapshot = currentSnapshot;
      schedulePaginationRescan();
    }
  });

  observer.observe(root instanceof Node ? root : document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-itemid"],
  });

  // SPA navigation re-scan: when entrypoints/content.ts dispatches the
  // `nsl:location-change` event we drop the WeakMap and rescan from scratch.
  // The same anchor element can now correspond to a different item id, so
  // dedup state from the previous URL must be cleared. Without this, a list
  // view that re-renders into a filtered view shows no new detections.
  const onLocationChange = (): void => {
    state.emitted = new WeakMap();
    // Rescan once on the next idle tick rather than synchronously: the
    // location change typically precedes the DOM re-render by one frame.
    schedule(() => {
      scanSubtree(state, root);
    });
  };
  window.addEventListener(LOCATION_CHANGE_EVENT, onLocationChange);

  return {
    onDetect(listener) {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
    destroy() {
      observer.disconnect();
      state.listeners.clear();
      window.removeEventListener(LOCATION_CHANGE_EVENT, onLocationChange);
      if (paginationTimer !== null) {
        clearTimeout(paginationTimer);
        paginationTimer = null;
      }
    },
  };
}
