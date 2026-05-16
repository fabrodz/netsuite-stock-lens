/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import type { ReactNode } from "react";
import { type Root, createRoot } from "react-dom/client";

// Shadow-DOM-anchored popup mount.
//
// Design decision: ship inline CSS in the shadow root rather than running
// Tailwind through the content-script CSS pipeline. WXT 0.20 injects content
// CSS into the host page's <head>, which would pollute NetSuite's global
// styles. The Shadow DOM root sidesteps that, and a ~5 KB hand-written
// stylesheet covers the small popup (header, four stat cells, footer link,
// loading skeleton, error, empty) without dragging in the full Tailwind
// runtime. Revisit if visual surface area grows.
//
// One singleton host per page: re-anchoring on each call keeps the React
// root warm, so the loaded-data flash from a second hover is instant. The
// host element is created once and reused; `hide()` only unmounts the React
// tree so we don't pay the Shadow DOM init cost again.

const HOST_TAG = "nsl-host";
const HOST_ID = "nsl-popup-host";
const VIEWPORT_MARGIN_PX = 8;

const POPUP_CSS = `
:host {
  all: initial;
}

.nsl-popup {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  color: #111827;
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.18);
  padding: 12px 14px;
  width: 320px;
  max-height: 480px;
  overflow-y: auto;
  box-sizing: border-box;
}

.nsl-popup__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid #f1f5f9;
}

.nsl-popup__title {
  font-weight: 600;
  font-size: 14px;
  color: #0f172a;
  word-break: break-word;
}

.nsl-popup__id {
  color: #64748b;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.nsl-popup__subtitle {
  color: #64748b;
  font-size: 11px;
  margin-top: 2px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.nsl-popup__stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.nsl-popup__stat {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 8px 10px;
}

.nsl-popup__stat-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #64748b;
  margin-bottom: 4px;
}

.nsl-popup__stat-value {
  font-size: 16px;
  font-weight: 600;
  color: #0f172a;
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.nsl-popup__footer {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid #f1f5f9;
}

.nsl-popup__footer-link {
  color: #2563eb;
  text-decoration: none;
  font-size: 12px;
}

.nsl-popup__footer-link:hover {
  text-decoration: underline;
}

.nsl-popup__loading-cell {
  background: #e2e8f0;
  border-radius: 6px;
  height: 44px;
  animation: nsl-pulse 1.2s ease-in-out infinite;
}

@keyframes nsl-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}

.nsl-popup__error {
  color: #b91c1c;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
}

.nsl-popup__retry {
  margin-top: 8px;
  font-size: 12px;
  color: #1d4ed8;
  background: transparent;
  border: 1px solid #bfdbfe;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
}

.nsl-popup__retry:hover {
  background: #eff6ff;
}

.nsl-popup__empty {
  color: #475569;
  font-style: italic;
  text-align: center;
  padding: 12px 0;
  font-size: 12px;
}

/* --- Header right-side, badge, sections, table, receipts, footer indicator. --- */

.nsl-popup__header-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.nsl-popup__header-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.nsl-popup__badge {
  display: inline-block;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  color: #ffffff;
  line-height: 1.2;
}

.nsl-popup__badge--red {
  background: #dc2626;
}

.nsl-popup__badge--yellow {
  background: #d97706;
}

.nsl-popup__badge--green {
  background: #16a34a;
}

.nsl-popup__section {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid #f1f5f9;
}

.nsl-popup__section-title {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #64748b;
  margin-bottom: 6px;
  font-weight: 600;
}

.nsl-popup__section-note {
  font-size: 11px;
  color: #94a3b8;
  font-style: italic;
}

.nsl-popup__locations-scroll {
  max-height: 168px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.nsl-popup__locations {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.nsl-popup__locations th {
  text-align: left;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #64748b;
  font-weight: 500;
  padding: 2px 6px 2px 0;
  border-bottom: 1px solid #e2e8f0;
  position: sticky;
  top: 0;
  background: #ffffff;
}

.nsl-popup__locations th:not(:first-child) {
  text-align: right;
}

.nsl-popup__locations td {
  padding: 3px 6px 3px 0;
  color: #0f172a;
  vertical-align: top;
}

.nsl-popup__locations td:not(:first-child) {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.nsl-popup__locations td:first-child {
  word-break: break-word;
}

.nsl-popup__locations-more {
  margin-top: 4px;
  font-size: 11px;
  font-style: italic;
  color: #64748b;
}

.nsl-popup__receipt {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 3px 0;
  font-size: 12px;
}

.nsl-popup__receipt + .nsl-popup__receipt {
  border-top: 1px dashed #f1f5f9;
}

.nsl-popup__receipt-vendor {
  flex: 1 1 auto;
  min-width: 0;
  color: #0f172a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nsl-popup__receipt-qty {
  flex-shrink: 0;
  color: #475569;
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.nsl-popup__receipt-date {
  flex-shrink: 0;
  color: #64748b;
  font-variant-numeric: tabular-nums;
  min-width: 36px;
  text-align: right;
}

.nsl-popup__footer {
  /* The footer needs to fit a refreshing indicator on the left and the
     full-record link on the right. Override the base single-flex layout. */
  justify-content: space-between;
  align-items: center;
}

.nsl-popup__refreshing {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-style: italic;
  color: #94a3b8;
}

.nsl-popup__refreshing-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #94a3b8;
  animation: nsl-spinner-pulse 0.9s ease-in-out infinite;
}

@keyframes nsl-spinner-pulse {
  0%, 100% { opacity: 0.3; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1.2); }
}

/* --- Tabs, recent-sales table, sale-type chip, demand block. --- */

.nsl-popup__tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid #e2e8f0;
  margin-bottom: 8px;
}

.nsl-popup__tab {
  background: transparent;
  border: none;
  padding: 4px 10px;
  font-size: 11px;
  font-weight: 500;
  color: #64748b;
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  font-family: inherit;
  line-height: 1.4;
}

.nsl-popup__tab:hover {
  color: #334155;
}

.nsl-popup__tab--active {
  color: #0f172a;
  border-bottom-color: #2563eb;
}

.nsl-popup__tab-body {
  padding-top: 4px;
}

.nsl-popup__recent-sales {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}

.nsl-popup__recent-sales th {
  text-align: left;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #64748b;
  font-weight: 500;
  padding: 2px 4px 2px 0;
  border-bottom: 1px solid #e2e8f0;
}

.nsl-popup__recent-sales th:nth-child(2),
.nsl-popup__recent-sales th:nth-child(3) {
  text-align: right;
}

.nsl-popup__recent-sales td {
  padding: 3px 4px 3px 0;
  color: #0f172a;
  vertical-align: top;
}

.nsl-popup__recent-sales td:first-child {
  word-break: break-word;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nsl-popup__recent-sales td:nth-child(2),
.nsl-popup__recent-sales td:nth-child(3) {
  text-align: right;
  font-variant-numeric: tabular-nums;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.nsl-popup__recent-sales td:nth-child(4) {
  font-variant-numeric: tabular-nums;
  color: #64748b;
  white-space: nowrap;
}

.nsl-popup__sale-type-chip {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 10px;
  background: #e2e8f0;
  color: #475569;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  line-height: 1.3;
}

.nsl-popup__demand {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.nsl-popup__demand-metric {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.nsl-popup__demand-note {
  font-size: 11px;
  font-style: italic;
  color: #64748b;
  margin-top: 2px;
}
`;

export interface PopupMount {
  // Anchors the popup to a target rect (e.g. anchor.getBoundingClientRect()).
  // Re-anchors on call; flips to stay on screen.
  // `triggerElement`, when provided, is inspected for NetSuite QV-trigger
  // markers (uir-hoverable-anchor / NS.UI.Tooltip inline handler). When
  // it looks like a QV trigger we hold off showing the standalone popup
  // so the appearance of NetSuite's own QV doesn't cause our content to
  // visibly jump from "standalone next to the link" to "embedded inside
  // the QV" — a transition the user sees as a flicker and that gives
  // NetSuite's QV a chance to auto-close while the cursor is in limbo.
  anchor(rect: DOMRect, triggerElement?: HTMLElement): void;
  render(node: ReactNode): void;
  hide(): void;
  isOpen(): boolean;
  // True while our React content is mounted inside NetSuite's native
  // QuickView (we share its lifecycle). The hover wiring uses this to skip
  // its mouseleave grace-timer hide: the cursor moving from the trigger
  // link into the QV body is a normal interaction, not a dismiss, and the
  // QV's own close handlers will tear us down when NetSuite decides the
  // QV is over.
  isInjected(): boolean;
}

interface MountState {
  host: HTMLElement;
  shadow: ShadowRoot;
  reactHost: HTMLDivElement;
  root: Root;
  open: boolean;
  lastAnchorRect: DOMRect | null;
  onCloseHandler: (() => void) | null;
  cleanupListeners: () => void;
  // Last React node passed to render(). Kept so we can re-render it into
  // the injected target if NetSuite's QuickView shows up after first paint.
  currentNode: ReactNode | null;
  // When NetSuite's native QuickView is open we mount a *second* React root
  // inside the QV's StackPanel, hide our standalone host, and ride the QV's
  // lifecycle. Two coexisting popups produced an unrecoverable hover-flicker
  // loop (NetSuite's QV closes whenever the cursor leaves both the trigger
  // and its own body — our standalone popup occluding either was enough).
  // Embedding sidesteps the problem: the user only sees one popup, our
  // content is part of NetSuite's overlay.
  injectedHost: HTMLElement | null;
  injectedRoot: Root | null;
  // Tracks the native QV card we mirror in height. Kept so the resize
  // observer can be torn down on cleanup and the height stays synced when
  // the native card grows (e.g. after the user expands a section).
  injectedNativeCard: HTMLElement | null;
  injectedSizeObserver: ResizeObserver | null;
  // MutationObserver on document.body that detects the QV being added or
  // removed. Created on anchor(), disconnected on hide().
  qvObserver: MutationObserver | null;
  // When we detect a QV-trigger anchor or a QV already in DOM but
  // invisible (fading in), we set this timer to wait briefly before
  // falling back to the standalone. The observer can cancel it as soon
  // as the QV becomes visible and we inject. Keeping the standalone off
  // during this window prevents the "show then hide" flicker.
  pendingQvTimer: number | null;
}

// Selectors that match NetSuite's native QuickView popup across Classic
// and Redwood UIs.
//
// Classic UI (verified 2026-05-14 on tstdrv*.app.netsuite.com): the popup
// is a direct <body> child built by NS.UI.Tooltip.tooltipFactory — both
// createRecordTooltip and createQuickViewTooltip funnel through it. The id
// and class are UIF-generated (`uif####`) and unstable, but the popup
// reliably carries `data-widget="Popover"` together with `role="tooltip"`.
//
// Redwood UI: `oj-popup` is the JET custom element NetSuite uses for
// popovers — kept as a best guess pending verification on a Redwood tenant.
const NATIVE_QV_SELECTORS: ReadonlyArray<string> = [
  '[data-widget="Popover"][role="tooltip"]',
  "oj-popup",
] as const;

// Inside the Classic QV (verified 2026-05-14 on Sales Order line items),
// the layout is:
//   Popover (root)
//     ↳ arrow (position: absolute, ~14×14)
//     ↳ chrome wrapper (drop shadow, fixed width)
//       ↳ white-bg wrapper (the visible "card")
//         ↳ WindowBody → StackPanel → Heading + ContentPanel
// To grow the QV horizontally we flip the Popover to a flex-row container
// and append our shadow host as a sibling of the chrome wrapper. Our host
// gets its own background + matching drop shadow (copied from the chrome
// wrapper) and its header copies the bg / font / height of NetSuite's
// own Heading so the two panels read as one continuous record card. A
// vertical grow pushed the panel off-screen on transaction surfaces.
const EMBEDDED_INJECT_WIDTH_PX = 320;

// Styles applied when our React root is mounted inside the QV. The
// visible chrome (card background, drop shadow, font) is set inline on
// the host element so we can mirror whatever the active NetSuite theme
// is using; the header styling is pulled from NetSuite's `[data-widget=
// "Heading"]` via CSS variables on the host with sensible fallbacks.
//
// The host element is sized in JS to match NetSuite's native panel
// height (with a ResizeObserver keeping them in sync). The popup just
// fills that host and scrolls internally when content exceeds it — so
// switching between the Inventory / Recent sales / Demand tabs always
// stays inside the painted card, no matter which tab's content is
// taller than the host.
const EMBEDDED_CSS = `${POPUP_CSS}
:host { all: initial; display: block; }
/*
 * Flex-column wrapping on the React root + min-height:0 on the popup is
 * the canonical pattern for "fill parent + scroll inside". Without
 * min-height:0, flex items default to min-height:auto, refuse to shrink
 * below their intrinsic content height, and overflow-y:auto never fires
 * — that was the exact symptom of the Recent-sales row escaping the card.
 */
.nsl-popup-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.nsl-popup {
  flex: 1 1 auto !important;
  min-height: 0 !important;
  font: inherit !important;
  color: inherit !important;
  width: auto !important;
  max-width: none !important;
  height: auto !important;
  max-height: none !important;
  background: transparent !important;
  border: none !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  padding: 12px 16px !important;
  box-sizing: border-box !important;
  overflow-y: auto !important;
}
.nsl-popup__header {
  background: var(--nsl-head-bg, rgb(223, 228, 235)) !important;
  color: var(--nsl-head-color, rgb(48, 48, 48)) !important;
  margin: -12px -16px 12px !important;
  padding: 0 16px !important;
  height: var(--nsl-head-height, 48px) !important;
  box-sizing: border-box !important;
  align-items: center !important;
  border-bottom: none !important;
}
.nsl-popup__title {
  font-size: var(--nsl-title-size, 18px) !important;
  font-weight: var(--nsl-title-weight, 600) !important;
  line-height: var(--nsl-title-line-height, 24px) !important;
}
`;

// Max wait, in ms, for NetSuite's QV to become visible after we detect a
// QV-trigger anchor or a pending (in-DOM but invisible) QV. NetSuite's
// observed delay is 400-900 ms; combined with our own 500 ms hover delay
// the QV is usually already visible or fading in by the time anchor() runs,
// so the timer rarely runs to completion.
const PENDING_QV_TIMEOUT_MS = 600;

// True when `el` (or a close ancestor) carries the markers NetSuite puts on
// elements that trigger a record-tooltip / QuickView popup on hover.
function isQvTrigger(el: HTMLElement | undefined): boolean {
  if (!el) return false;
  const HOVER_RE = /uir-hoverable-anchor|hoverable-anchor/i;
  const MO_RE = /NS\.UI\.Tooltip|createRecordTooltip|createQuickViewTooltip/i;
  let cursor: HTMLElement | null = el;
  let depth = 0;
  while (cursor && depth <= 2) {
    const cls = typeof cursor.className === "string" ? cursor.className : "";
    if (HOVER_RE.test(cls)) return true;
    const mo = cursor.getAttribute("onmouseover");
    if (mo && MO_RE.test(mo)) return true;
    cursor = cursor.parentElement;
    depth++;
  }
  return false;
}

// Returns the QV element if NetSuite has it in DOM regardless of visibility.
// Used at anchor() time to detect a QV that's mid-fade-in.
function findPendingQv(): HTMLElement | null {
  for (const selector of NATIVE_QV_SELECTORS) {
    let candidates: NodeListOf<Element>;
    try {
      candidates = document.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const el of candidates) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.id === HOST_ID || el.querySelector(`#${HOST_ID}`)) continue;
      return el;
    }
  }
  return null;
}

function clearPendingQvTimer(state: MountState): void {
  if (state.pendingQvTimer !== null) {
    clearTimeout(state.pendingQvTimer);
    state.pendingQvTimer = null;
  }
}

function findNativeQv(): HTMLElement | null {
  for (const selector of NATIVE_QV_SELECTORS) {
    let candidates: NodeListOf<Element>;
    try {
      candidates = document.querySelectorAll(selector);
    } catch {
      // CSS.escape isn't available in some old contexts; skip a bad
      // selector rather than failing the whole lookup.
      continue;
    }
    for (const el of candidates) {
      if (!(el instanceof HTMLElement)) continue;
      // Defensive: never treat our own host as a QV.
      if (el.id === HOST_ID || el.querySelector(`#${HOST_ID}`)) continue;
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 50) continue;
      return el;
    }
  }
  return null;
}

let singleton: MountState | null = null;

function tryDefineHostElement(): boolean {
  // Some NetSuite pages (observed on the Classic dashboard at
  // /app/center/card.nl) expose `customElements` as `null` rather than the
  // usual CustomElementRegistry. We defensively fall back to a plain `<div>`
  // host when the registry is unavailable — Shadow DOM attaches to any
  // element, so the custom-element name is only a nicety for dev-mode
  // hot-reload identification.
  // biome-ignore lint/suspicious/noExplicitAny: probing a host-injected global
  const registry = (globalThis as any).customElements as CustomElementRegistry | null | undefined;
  if (!registry || typeof registry.get !== "function") return false;
  try {
    if (registry.get(HOST_TAG)) return true;
    registry.define(HOST_TAG, class extends HTMLElement {});
    return true;
  } catch {
    return false;
  }
}

function ensureHost(): MountState {
  if (singleton) return singleton;
  const useCustomElement = tryDefineHostElement();

  const host = document.createElement(useCustomElement ? HOST_TAG : "div");
  host.id = HOST_ID;
  host.style.position = "fixed";
  host.style.zIndex = "999999";
  host.style.top = "0";
  host.style.left = "0";
  host.style.pointerEvents = "auto";
  host.style.display = "none";

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = POPUP_CSS;
  shadow.appendChild(style);

  const reactHost = document.createElement("div");
  reactHost.className = "nsl-popup-root";
  shadow.appendChild(reactHost);

  document.body.appendChild(host);

  const root = createRoot(reactHost);

  const state: MountState = {
    host,
    shadow,
    reactHost,
    root,
    open: false,
    lastAnchorRect: null,
    onCloseHandler: null,
    cleanupListeners: () => {
      /* replaced below */
    },
    currentNode: null,
    injectedHost: null,
    injectedRoot: null,
    injectedNativeCard: null,
    injectedSizeObserver: null,
    qvObserver: null,
    pendingQvTimer: null,
  };

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && state.open) {
      state.onCloseHandler?.();
    }
  }
  function onClickOutside(event: MouseEvent): void {
    if (!state.open) return;
    // Only treat left-button mousedowns as dismiss intent. Middle-click
    // (open link in new tab) and right-click (context menu) leave the
    // page intact and should not close the popup. NetSuite's own QV
    // does the same.
    if (event.button !== 0) return;
    // In embedded mode our React tree lives inside NetSuite's QV, so the
    // QV owns dismissal — our MutationObserver tears us down when the QV
    // is removed. Skipping our own click-outside here avoids closing
    // ahead of NetSuite (which would leave the OOB panel orphaned with
    // our column gone).
    if (state.injectedHost !== null) return;
    // composedPath() crosses shadow boundaries; if our host is in the path,
    // the click happened inside the popup and we don't dismiss.
    const path = event.composedPath();
    if (path.includes(state.host)) return;
    state.onCloseHandler?.();
  }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("mousedown", onClickOutside);
  state.cleanupListeners = () => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("mousedown", onClickOutside);
  };

  singleton = state;
  return state;
}

function position(state: MountState, rect: DOMRect): void {
  // Measure after the host is visible so layout has run.
  state.host.style.display = "block";
  const popupRect = state.reactHost.getBoundingClientRect();
  // If the React content hasn't rendered yet, popupRect will be 0×0; we
  // default to typical popup dimensions so the initial position is
  // reasonable. A second `position` call after content paints corrects it.
  const popupW = popupRect.width > 0 ? popupRect.width : 320;
  const popupH = popupRect.height > 0 ? popupRect.height : 160;

  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Standalone placement: flip-below-or-above relative to the hovered
  // anchor. When NetSuite's QuickView is open we don't position the
  // standalone host at all — we hide it and mount inside the QV instead
  // (see injectIntoQv).
  const spaceBelow = vh - rect.bottom;
  const spaceAbove = rect.top;
  let top: number;
  if (spaceBelow >= popupH + VIEWPORT_MARGIN_PX || spaceBelow >= spaceAbove) {
    top = rect.bottom + 6;
  } else {
    top = rect.top - popupH - 6;
  }
  const spaceRight = vw - rect.left;
  const spaceLeft = rect.right;
  let left: number;
  if (spaceRight >= popupW + VIEWPORT_MARGIN_PX || spaceRight >= spaceLeft) {
    left = rect.left;
  } else {
    left = rect.right - popupW;
  }

  // Clamp to the viewport with an 8 px margin.
  const maxTop = vh - popupH - VIEWPORT_MARGIN_PX;
  const maxLeft = vw - popupW - VIEWPORT_MARGIN_PX;
  if (top > maxTop) top = maxTop;
  if (top < VIEWPORT_MARGIN_PX) top = VIEWPORT_MARGIN_PX;
  if (left > maxLeft) left = maxLeft;
  if (left < VIEWPORT_MARGIN_PX) left = VIEWPORT_MARGIN_PX;

  state.host.style.top = `${Math.round(top)}px`;
  state.host.style.left = `${Math.round(left)}px`;
}

function injectIntoQv(state: MountState, qv: HTMLElement): void {
  if (state.injectedHost) return;

  // Identify the chrome wrapper: the largest direct child of the Popover.
  // (The arrow is a sibling but small.) The chrome owns the drop shadow.
  let chrome: HTMLElement | null = null;
  let chromeArea = 0;
  for (const c of qv.children) {
    if (!(c instanceof HTMLElement)) continue;
    const r = c.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > chromeArea) {
      chrome = c;
      chromeArea = area;
    }
  }
  // Find the element that actually paints the visible card (opaque
  // background, popup-sized). On Classic this is one wrapper below the
  // chrome; on Redwood it may be the popover itself. We mirror its
  // background color and the chrome's drop shadow onto our own host so
  // our column reads as a connected sister panel rather than a floating
  // unstyled block.
  let bgCardEl: HTMLElement | null = null;
  const findBg = (el: HTMLElement): void => {
    if (bgCardEl) return;
    const cs = window.getComputedStyle(el);
    if (
      cs.backgroundColor &&
      cs.backgroundColor !== "rgba(0, 0, 0, 0)" &&
      cs.backgroundColor !== "transparent"
    ) {
      const r = el.getBoundingClientRect();
      if (r.width > 200 && r.height > 100) {
        bgCardEl = el;
        return;
      }
    }
    for (const c of el.children) {
      if (c instanceof HTMLElement) findBg(c);
    }
  };
  findBg(qv);
  const qvStyle = window.getComputedStyle(qv);
  const bgCardStyle = bgCardEl ? window.getComputedStyle(bgCardEl as HTMLElement) : null;
  const cardBg = bgCardStyle?.backgroundColor ?? "#ffffff";
  const chromeShadow = chrome ? window.getComputedStyle(chrome).boxShadow : "none";

  const injected = document.createElement("div");
  injected.setAttribute("data-nsl-injected", "true");
  // Visual styling lives on the host element so each injection mirrors
  // the active NetSuite theme (font/color/shadow vary by version + tenant).
  injected.style.display = "block";
  injected.style.boxSizing = "border-box";
  injected.style.width = `${EMBEDDED_INJECT_WIDTH_PX}px`;
  injected.style.flexShrink = "0";
  // Opt out of the QV's `align-items: stretch` and pin the host to the
  // native card's measured height instead. Stretch ties our cross-axis to
  // the flex line, which on cached (synchronous) hovers is measured before
  // React commits our content — pinning to that snapshot meant tab
  // switches spilled the taller tab past the painted card. With explicit
  // height + `overflow-y: auto` inside, the popup always scrolls
  // internally and visually matches NetSuite's panel.
  injected.style.alignSelf = "flex-start";
  if (bgCardEl) {
    const nativeHeight = (bgCardEl as HTMLElement).getBoundingClientRect().height;
    if (nativeHeight > 0) {
      injected.style.height = `${Math.round(nativeHeight)}px`;
    }
  }
  // Safety clip: `.nsl-popup` inside the shadow root has its own
  // `overflow-y: auto`, but `height: 100%` doesn't always resolve cleanly
  // through `:host { all: initial }` — when it falls back to auto, the
  // popup's overflow never fires and the last rows render past the card.
  // Clipping on the host itself guarantees nothing escapes the painted
  // background regardless of how the inner sizing resolves.
  injected.style.overflow = "hidden";
  injected.style.background = cardBg;
  injected.style.color = qvStyle.color;
  injected.style.fontFamily = qvStyle.fontFamily;
  injected.style.fontSize = qvStyle.fontSize;
  if (chromeShadow && chromeShadow !== "none") {
    injected.style.boxShadow = chromeShadow;
  }
  if (bgCardStyle?.borderRadius && bgCardStyle.borderRadius !== "0px") {
    injected.style.borderRadius = bgCardStyle.borderRadius;
  }
  // Mirror NetSuite's Heading widget (bg, text color, height, title font)
  // onto our own header via CSS custom properties. The EMBEDDED_CSS block
  // reads these with fallbacks, so if no Heading is present we still get
  // sane defaults.
  const heading = qv.querySelector('[data-widget="Heading"]');
  if (heading instanceof HTMLElement) {
    const headingStyle = window.getComputedStyle(heading);
    injected.style.setProperty("--nsl-head-bg", headingStyle.backgroundColor);
    injected.style.setProperty("--nsl-head-color", headingStyle.color);
    injected.style.setProperty("--nsl-head-height", headingStyle.height);
    // The title text inside the Heading carries the font-size/weight we
    // want to mirror — find the deepest text-bearing descendant.
    let titleEl: HTMLElement | null = null;
    for (const e of heading.querySelectorAll<HTMLElement>("*")) {
      if ((e.textContent || "").trim() && e.children.length === 0) {
        titleEl = e;
        break;
      }
    }
    if (titleEl) {
      const titleStyle = window.getComputedStyle(titleEl);
      injected.style.setProperty("--nsl-title-size", titleStyle.fontSize);
      injected.style.setProperty("--nsl-title-weight", titleStyle.fontWeight);
      injected.style.setProperty("--nsl-title-line-height", titleStyle.lineHeight);
    }
  }

  const injectedShadow = injected.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = EMBEDDED_CSS;
  injectedShadow.appendChild(style);
  const injectedReact = document.createElement("div");
  injectedReact.className = "nsl-popup-root";
  injectedShadow.appendChild(injectedReact);
  qv.appendChild(injected);

  // Flip the Popover to a row layout and unconstrain its width so it
  // accommodates the extra column. The arrow inside the Popover is
  // `position:absolute`, so it ignores the flex flow. Styles live on
  // NetSuite's own element and are discarded with the QV when NetSuite
  // removes it from the DOM.
  qv.style.setProperty("display", "flex", "important");
  qv.style.setProperty("flex-direction", "row", "important");
  qv.style.setProperty("align-items", "stretch", "important");
  qv.style.setProperty("width", "auto", "important");
  qv.style.setProperty("max-width", "none", "important");

  state.injectedHost = injected;
  state.injectedRoot = createRoot(injectedReact);
  if (state.currentNode != null) state.injectedRoot.render(state.currentNode);
  // Standalone is suppressed while we're embedded.
  state.host.style.display = "none";

  // Keep our host height in sync with NetSuite's native card. The card can
  // grow after first paint (expand-on-hover sections, late-loading images),
  // and without this observer we'd freeze at the initial measurement and
  // either show a gap below NetSuite's card or clip if it grew. `bgCardEl`
  // is the visible card element; `ResizeObserver` is supported in all
  // Chromium versions we target.
  if (bgCardEl && typeof ResizeObserver !== "undefined") {
    state.injectedNativeCard = bgCardEl as HTMLElement;
    const observer = new ResizeObserver((entries) => {
      if (!state.injectedHost) return;
      const entry = entries[0];
      if (!entry) return;
      const next = Math.round(entry.contentRect.height);
      if (next > 0) {
        state.injectedHost.style.height = `${next}px`;
      }
    });
    observer.observe(bgCardEl as HTMLElement);
    state.injectedSizeObserver = observer;
  }
}

function cleanupInjected(state: MountState): void {
  if (state.injectedSizeObserver) {
    state.injectedSizeObserver.disconnect();
    state.injectedSizeObserver = null;
  }
  state.injectedNativeCard = null;
  if (state.injectedRoot) {
    try {
      state.injectedRoot.unmount();
    } catch {
      // React may already be unmounted if NetSuite tore the QV down.
    }
    state.injectedRoot = null;
  }
  if (state.injectedHost?.parentNode) {
    state.injectedHost.parentNode.removeChild(state.injectedHost);
  }
  state.injectedHost = null;
}

function startQvObserver(state: MountState): void {
  if (state.qvObserver) return;
  const obs = new MutationObserver(() => {
    if (!state.open) return;
    // When the user moves between item links, NetSuite removes the old
    // Popover element and creates a brand-new one in the same mutation
    // batch. Our injected host (which lived inside the old Popover) is
    // gone with it — `state.injectedHost.isConnected` flips to false —
    // but the reference is still set, so the "inject" branch below
    // wouldn't fire for the new QV and the "QV gone" branch wouldn't
    // fire because a new QV is visible. Reconcile first: drop the
    // orphaned reference so the branches below can act on real state.
    const hadInjection = state.injectedHost !== null;
    if (state.injectedHost && !state.injectedHost.isConnected) {
      if (state.injectedSizeObserver) {
        state.injectedSizeObserver.disconnect();
        state.injectedSizeObserver = null;
      }
      state.injectedNativeCard = null;
      if (state.injectedRoot) {
        try {
          state.injectedRoot.unmount();
        } catch {
          // Already unmounted (React may detect detachment first).
        }
        state.injectedRoot = null;
      }
      state.injectedHost = null;
    }
    const qv = findNativeQv();
    if (qv && !state.injectedHost) {
      // Either an initial inject, or a re-inject into the replacement QV
      // after the previous one was swapped out from under us.
      clearPendingQvTimer(state);
      injectIntoQv(state, qv);
    } else if (!qv && hadInjection) {
      // The QV we were embedded in is gone for good (no replacement in
      // this mutation batch). Tear down what's left and notify the
      // consumer so its open-state syncs — our popup shares the QV's
      // lifecycle in this mode.
      cleanupInjected(state);
      state.onCloseHandler?.();
    }
  });
  // childList catches the QV being appended/removed from the body subtree,
  // but NetSuite first inserts its Popover with `opacity: 0` and then
  // animates it to 1 via a `style`/`class` change. Without observing those
  // attribute mutations our observer never fires for the visibility
  // transition, the wait timer falls back to showing the standalone, and
  // the user ends up with two panels visible at once. `attributeFilter`
  // keeps the callback work bounded to the few attributes NetSuite uses
  // to flip visibility (`style` for inline opacity, `class` for theme
  // transitions, `data-state` for the popover's own state machine).
  obs.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class", "data-state"],
  });
  state.qvObserver = obs;
}

function stopQvObserver(state: MountState): void {
  if (state.qvObserver) {
    state.qvObserver.disconnect();
    state.qvObserver = null;
  }
}

export function getOrCreatePopupMount(): PopupMount {
  const state = ensureHost();

  return {
    anchor(rect, triggerElement) {
      state.lastAnchorRect = rect;
      state.open = true;
      // Reset visible state from any prior hover. Without hiding the
      // standalone host here, switching from item A to item B while A's
      // popup was already visible left A's panel floating alongside B's
      // injected panel — `position()` only flips display to "block" when
      // it runs, never back to "none" on its own.
      cleanupInjected(state);
      clearPendingQvTimer(state);
      state.host.style.display = "none";

      const qv = findNativeQv();
      if (qv) {
        injectIntoQv(state, qv);
        startQvObserver(state);
        return;
      }
      // Decide whether to wait for an incoming QV before showing standalone.
      // Two signals say "QV is coming": the trigger anchor itself looks
      // like a NetSuite tooltip trigger, OR the QV element is already in
      // DOM but invisible (NetSuite started its fade-in). Either way we
      // stay quiet until the observer either injects (QV became visible)
      // or the timeout fires — otherwise the standalone would appear next
      // to the link and then jump to embedded inside the QV, which the
      // user reads as a flicker and gives NetSuite's QV a chance to
      // auto-close mid-transition.
      if (isQvTrigger(triggerElement) || findPendingQv()) {
        state.pendingQvTimer = window.setTimeout(() => {
          state.pendingQvTimer = null;
          if (!state.open || state.injectedHost) return;
          if (state.lastAnchorRect) position(state, state.lastAnchorRect);
        }, PENDING_QV_TIMEOUT_MS);
      } else {
        position(state, rect);
      }
      startQvObserver(state);
    },
    render(node) {
      // Walk the node tree looking for an onClose prop on the root element
      // so click-outside / Escape can reach the consumer. We only inspect
      // the top-level node; nested components manage their own close.
      const candidate = node as { props?: { onClose?: () => void } } | null;
      state.onCloseHandler = candidate?.props?.onClose ?? null;
      state.currentNode = node;
      if (state.injectedRoot) {
        // Embedded mode: render only into the injected tree. The standalone
        // host stays hidden and its React root keeps whatever it had.
        state.injectedRoot.render(node);
        return;
      }
      state.root.render(node);
      // Re-position after a frame: content size only becomes accurate after
      // React commits. Skip if we've switched to embedded in the meantime,
      // or if we're still waiting on a pending QV (standalone is intentionally
      // hidden until the wait resolves).
      requestAnimationFrame(() => {
        if (
          state.open &&
          state.lastAnchorRect &&
          !state.injectedHost &&
          state.pendingQvTimer === null
        ) {
          position(state, state.lastAnchorRect);
        }
      });
    },
    hide() {
      if (!state.open) return;
      state.open = false;
      stopQvObserver(state);
      clearPendingQvTimer(state);
      cleanupInjected(state);
      state.host.style.display = "none";
      // Unmount the React tree so effects clean up (e.g. abort in-flight
      // fetches). Host stays mounted for reuse.
      state.root.render(null);
      state.onCloseHandler = null;
      state.currentNode = null;
    },
    isOpen() {
      return state.open;
    },
    isInjected() {
      return state.injectedHost !== null;
    },
  };
}

// Test-only helper: tears down the singleton so a fresh mount can be created.
// Not part of the public API; the export keeps it discoverable for unit tests
// that need clean state between cases.
export function __resetPopupMountForTests(): void {
  if (!singleton) return;
  stopQvObserver(singleton);
  clearPendingQvTimer(singleton);
  cleanupInjected(singleton);
  singleton.cleanupListeners();
  singleton.root.unmount();
  singleton.host.remove();
  singleton = null;
}
