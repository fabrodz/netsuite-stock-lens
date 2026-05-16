/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { findLineQuantity } from "@/content/line-quantity";
import { type BadgeColor, badgeColor } from "@/content/popup/badge";
import { itemHeaderCache, itemHeaderCacheKey, l1ItemHeader } from "@/content/popup/cache-instance";
import {
  DEFAULT_PREFERENCES,
  type Preferences,
  getPreferences,
  onPreferencesChanged,
} from "@/lib/preferences";
import { mapSuiteQLError } from "@/lib/queries/error-mapping";
import { type DemandResult, runItemDemandQuery } from "@/lib/queries/itemDemand";
import { type ItemHeader, runItemHeaderQuery } from "@/lib/queries/itemHeader";
import { type ItemLocation, runItemLocationsQuery } from "@/lib/queries/itemLocations";
import { type NextReceiptRow, runItemNextReceiptQuery } from "@/lib/queries/itemNextReceipt";
import { type RecentSale, runItemRecentSalesQuery } from "@/lib/queries/itemRecentSales";
import { type QueryBudget, createQueryBudget } from "@/lib/query-budget";
import { shouldSkipQuery } from "@/lib/schemaAdapter";
import { type SchemaProbeResult, getOrProbeSchema } from "@/lib/schemaProbe";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Hover popup.
//
// Builds on the base layout (header, totals, locations, next-receipt)
// and adds two opt-in cross-record slices: recent sales and demand. When
// both opt-ins are on, the popup grows a tabbed footer; with only one on,
// the extra section renders inline under the inventory.
//
// Query budget: one `createQueryBudget()` instance per hover. Every fetch
// site acquires from the same instance so a total-budget overrun cancels
// all in-flight queries at once and the popup renders whatever already
// resolved. NB: the bridge does not currently propagate AbortSignal into
// the page-context layer, so a mid-flight abort
// is a logical-only signal — the underlying fetch keeps running and its
// late resolution is ignored by this component.

// The L1 + persistent cache live in `cache-instance.ts` so the
// list-view prefetcher (`src/content/prefetch.ts`) can share the same
// instances without pulling in HoverPopup's React subtree.

// Item-types that don't track inventory. Showing zeros for these reads as
// "out of stock" even though NetSuite never tracked the quantity in the
// first place; collapse them to a "no inventory tracked" empty state.
const NON_INVENTORY_TYPES = new Set([
  "NonInvtPart",
  "Service",
  "DownloadItem",
  "OthCharge",
  "Description",
  "GiftCert",
  "Subtotal",
]);

// Max rows rendered in the locations table before we truncate. Anything
// larger gets a "+N more" footer; the user can open the full record for
// the complete list.
const MAX_LOCATIONS_VISIBLE = 8;
// Max rows rendered in the next-receipt list. The underlying SuiteQL
// query already FETCH FIRST 3, so this is a defensive cap.
const MAX_RECEIPTS_VISIBLE = 3;
// Max rows rendered in the recent-sales tab. The underlying SuiteQL
// query already FETCH FIRST 5, so this is a defensive cap.
const MAX_SALES_VISIBLE = 5;

function formatQty(n: number): string {
  // Defensive rounding: SuiteQL occasionally returns floating-point noise on
  // SUM(NVL(...)) when a column is fractional. Display whole units for
  // discrete inventory and up to 2 decimals for fractional UOM items.
  const rounded = Math.round(n * 100) / 100;
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// Formats a NetSuite date string (YYYY-MM-DD or ISO) into "M/D" for the
// receipt section. Falls back to the raw string if parsing fails so the
// user still sees something useful.
function formatDueDate(raw: string | null): string {
  if (raw === null || raw.length === 0) return "—";
  // SuiteQL returns dates as "YYYY-MM-DD" or "MM/DD/YYYY" depending on the
  // account locale. Try parsing as Date first; if NaN, return the raw text.
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  // Use locale-neutral M/D ordering for compactness; the popup is tight on
  // horizontal space and Y always matches the current fiscal context.
  return `${parsed.getMonth() + 1}/${parsed.getDate()}`;
}

// Currency-style formatter for unit rate. We pick toLocaleString with two
// decimals rather than a fixed locale so the user sees what their system
// formats look like; rate is always positive in the SuiteQL result but a
// credit memo line can carry it through with the line's sign.
function formatRate(n: number): string {
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Maps SuiteQL `type` codes to short chip labels for the recent-sales table.
// CustInvc is the default; the other two are common but uncommon enough that
// users want them visually distinct.
function saleTypeLabel(type: string): string {
  if (type === "CashSale") return "Cash";
  if (type === "CustCred") return "CM";
  // CustInvc + anything unforeseen we treat as invoice; the chip exists
  // mainly to highlight the two minority cases.
  return "Invc";
}

export interface HoverPopupProps {
  itemId: string;
  accountId: string;
  // The hovered DOM element. Used to walk up to the line row and parse the
  // line quantity for the badge. Treated as readonly; the popup never
  // mutates the host page.
  anchor: HTMLElement;
  // When set, the "Next receipt" query excludes this transaction id. Used
  // by the PO and Transfer Order surfaces so a record viewing itself does
  // not appear as one of its own upcoming receipts.
  excludeTrxId?: string;
  // List-view surfaces (saved searches, item lists, reports) lack
  // per-line context. When true the popup:
  //   - skips the `findLineQuantity` DOM walk (the anchor has no enclosing
  //     transaction row),
  //   - forces the status badge to "hidden" because there's no lineQty to
  //     compare against `available`,
  //   - ignores any `excludeTrxId` (also covered by the prop being optional).
  // The flag is intentionally narrow: data fetching, cache, and rendering
  // are otherwise identical to the transaction-surface path.
  listViewMode?: boolean;
  onClose(): void;
}

// Per-slice state. `value` holds the most recent successful payload (or
// null if we never received one), `error` holds the most recent rejection
// (or null), and `fresh` flips to true once SWR has confirmed the value
// against a live fetch. For the in-memory LRU cache, `fresh` is always true
// because there's no stale-cache notion yet.
interface SliceState<T> {
  value: T | null;
  error: unknown | null;
  fresh: boolean;
}

interface PopupState {
  header: SliceState<ItemHeader>;
  locations: SliceState<ItemLocation[]>;
  nextReceipts: SliceState<NextReceiptRow[]>;
  recentSales: SliceState<RecentSale[]>;
  demand: SliceState<DemandResult>;
  // Set to true when a stale render is being refetched. Drives the
  // footer "refreshing…" indicator.
  refreshing: boolean;
}

const INITIAL_STATE: PopupState = {
  header: { value: null, error: null, fresh: false },
  locations: { value: null, error: null, fresh: false },
  nextReceipts: { value: null, error: null, fresh: false },
  recentSales: { value: null, error: null, fresh: false },
  demand: { value: null, error: null, fresh: false },
  refreshing: false,
};

// Friendly error UI maps each FriendlyErrorCode to display copy and
// whether retry is offered. Mirrors the spec table; keeping it inline so
// changing copy is a one-file edit.
interface ErrorUI {
  message: string;
  showRetry: boolean;
}

function errorUI(code: ReturnType<typeof mapSuiteQLError>): ErrorUI {
  switch (code) {
    case "inventory-not-enabled":
      return { message: "Inventory tracking not enabled for this item", showRetry: false };
    case "no-permission":
      return { message: "No permission to view inventory", showRetry: false };
    case "timeout":
      return { message: "NetSuite is slow right now", showRetry: true };
    case "item-not-found":
      return { message: "Item not found", showRetry: false };
    case "n-query-unavailable":
      return { message: "Inventory data not available on this page", showRetry: false };
    default:
      return { message: "Couldn't fetch inventory", showRetry: true };
  }
}

interface ErrorStateProps {
  message: string;
  showRetry: boolean;
  onRetry(): void;
}

function ErrorState(props: ErrorStateProps): JSX.Element {
  return (
    <div
      className="nsl-popup"
      // biome-ignore lint/a11y/useSemanticElements: native <dialog> implies
      // modal behaviour (focus trap, ::backdrop) that conflicts with a
      // hover-anchored, non-modal popup. role="dialog" is the right ARIA
      // affordance here.
      role="dialog"
      aria-label="Stock Lens error"
    >
      <div className="nsl-popup__header">
        <div className="nsl-popup__title">Stock Lens</div>
      </div>
      <div className="nsl-popup__error">{props.message}</div>
      {props.showRetry ? (
        <button type="button" className="nsl-popup__retry" onClick={props.onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

// Cross-record tab discriminant. Inventory is the always-available tab
// (because the inventory data is rendered above the tabs); the other two
// are gated by preferences.
type CrossTab = "inventory" | "recent-sales" | "demand";

export function HoverPopup(props: HoverPopupProps): JSX.Element {
  const { itemId, accountId, anchor, excludeTrxId, listViewMode = false } = props;
  const [state, setState] = useState<PopupState>(INITIAL_STATE);

  // Live preferences: we read them once at mount and then subscribe so that
  // toggling "Show recent sales" / "Show demand" in the options page takes
  // effect on the next render without reopening the popup. Until prefs load,
  // we default to the base behaviour (no cross-record sections) so the popup
  // doesn't briefly show a tab UI that then disappears.
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFERENCES);
  useEffect(() => {
    let cancelled = false;
    getPreferences()
      .then((p) => {
        if (!cancelled) setPrefs(p);
      })
      .catch(() => {
        // Storage may be unavailable in some Manifest V3 edge cases (e.g.
        // service-worker just restarted). Defaults already loaded.
      });
    const unsubscribe = onPreferencesChanged((next) => setPrefs(next));
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Default tab when both opt-ins are on. Recent sales is the more useful
  // landing point: it's the data NetSuite hides best (last 5 invoices
  // requires opening a saved search). Demand is a derived number that's
  // less actionable as a default.
  const [activeTab, setActiveTab] = useState<CrossTab>("recent-sales");

  // Cache the per-account schema probe in a ref so each fetch site
  // can synchronously read it before issuing a query (e.g. skipping the
  // locations call on MLI-off accounts). A ref instead of state because:
  //   1. Schema rarely changes during a popup's lifetime — re-rendering on
  //      probe completion would discard partial fetches.
  //   2. Subsequent hovers in the same tab share the cached probe via
  //      `getOrProbeSchema` (chrome.storage.local), so the first-popup
  //      latency cost is paid once per account, not per hover.
  // When the probe hasn't resolved yet (`null`), `shouldSkipQuery` falls
  // through to "never skip", so the first popup behaves as before. The
  // second popup benefits from the cached probe.
  const schemaRef = useRef<SchemaProbeResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    getOrProbeSchema(accountId)
      .then((result) => {
        if (!cancelled) {
          schemaRef.current = result;
        }
      })
      .catch((err) => {
        // Probe failure is non-fatal: the popup falls back to "don't skip
        // anything" which is the safe default.
        console.warn("[nsl] schema probe failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  // Parse the line quantity once on mount. The anchor reference is stable
  // for the lifetime of the popup (one popup per hover), so we don't need
  // to re-read it on every render. Memoised to keep the dependency array
  // of the badge computation stable.
  //
  // In list-view mode we deliberately skip the DOM walk. The
  // anchor sits inside a result table row that has no transaction-line
  // semantics ("how many of this item am I about to commit?"). Reading a
  // quantity column from a list row would produce a misleading badge.
  const lineQty = useMemo<number | null>(() => {
    if (listViewMode) return null;
    try {
      return findLineQuantity(anchor);
    } catch (err) {
      // findLineQuantity is defensive, but a malformed DOM (e.g. an anchor
      // that's been detached between hover and render) could still throw.
      // We never want a thrown DOM read to break the popup.
      console.warn("[nsl] findLineQuantity threw", err);
      return null;
    }
  }, [anchor, listViewMode]);

  const load = useCallback(() => {
    let cancelled = false;
    setState(INITIAL_STATE);

    // One budget per hover. All five fetch sites acquire from it so a
    // total-budget overrun cancels every still-pending query at once.
    const budget: QueryBudget = createQueryBudget();

    const headerKey = itemHeaderCacheKey(accountId, itemId);

    // Helper: standardises the acquire/signalDone bookkeeping for each
    // fetch site. The query function receives the budget-bound AbortSignal
    // so callers compose it into their own controllers. `timedOut` is
    // derived from the signal's reason at settle time so the budget
    // counter reflects which path the abort came from.
    function runWithBudget<T>(
      queryType: string,
      run: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
      const handle = budget.acquire(queryType);
      const { controller } = handle;
      return run(controller.signal)
        .then((value) => {
          const reason = (controller.signal.reason as { name?: string } | undefined) ?? undefined;
          handle.signalDone(true, reason?.name === "AbortError");
          return value;
        })
        .catch((err: unknown) => {
          const isAbort =
            err instanceof DOMException && err.name === "AbortError" && controller.signal.aborted;
          handle.signalDone(false, isAbort);
          throw err;
        });
    }

    // Header fetch — gated by the persistent cache. SWR emits the stale
    // value first (if any) so the popup renders immediately, then emits
    // the fresh value when the background fetch resolves.
    runWithBudget("header", (signal) =>
      itemHeaderCache.fetchSWR(
        headerKey,
        () => runItemHeaderQuery(itemId, signal),
        (value, status) => {
          if (cancelled) return;
          if (status === "fetching") {
            return;
          }
          if (value === null) return;
          const isStale = status === "stale-l1" || status === "stale-l2";
          setState((s) => ({
            ...s,
            header: { value, error: null, fresh: !isStale },
            refreshing: isStale,
          }));
        },
      ),
    )
      .then(() => {
        if (cancelled) return;
        setState((s) => ({ ...s, refreshing: false }));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState((s) => ({
          ...s,
          header: { value: null, error: err, fresh: true },
          refreshing: false,
        }));
      });

    // Locations fetch — independent. An empty array is a valid result
    // (MLI off) and renders the "section hidden" UX.
    //
    // When the schema probe has confirmed MLI is off, skip the
    // round-trip entirely and synthesize an empty result. Saves a 200-
    // 500 ms SuiteQL call that we already know returns no rows. Falling
    // back to `null` schema (probe not yet resolved) means we keep firing
    // the call — see the `schemaRef` comment above.
    if (shouldSkipQuery(schemaRef.current, "itemLocations")) {
      // Synthetic "skipped" state: empty array, no error. Renders the
      // same way as a successful empty result, so the "By location"
      // section is hidden without an error note.
      setState((s) => ({ ...s, locations: { value: [], error: null, fresh: true } }));
    } else {
      runWithBudget("locations", (signal) => runItemLocationsQuery(itemId, signal))
        .then((value) => {
          if (cancelled) return;
          setState((s) => ({ ...s, locations: { value, error: null, fresh: true } }));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setState((s) => ({ ...s, locations: { value: null, error: err, fresh: true } }));
        });
    }

    // Next receipts fetch — independent. Errors here hide the section
    // with a small inline note rather than killing the whole popup. On
    // PO/TO surfaces we pass excludeTrxId so the current record is
    // filtered out of its own receipts list.
    runWithBudget("next-receipts", (signal) =>
      runItemNextReceiptQuery(itemId, {
        excludeTrxId,
        signal,
      }),
    )
      .then((value) => {
        if (cancelled) return;
        setState((s) => ({ ...s, nextReceipts: { value, error: null, fresh: true } }));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState((s) => ({ ...s, nextReceipts: { value: null, error: err, fresh: true } }));
      });

    // Cross-record opt-in fetches. We snapshot the preference at load time
    // so a mid-load preference flip doesn't issue extra queries; the
    // subscribe-then-rerender path picks up new prefs on the next hover.
    if (prefs.showRecentSales) {
      runWithBudget("recent-sales", (signal) => runItemRecentSalesQuery(itemId, signal))
        .then((value) => {
          if (cancelled) return;
          setState((s) => ({ ...s, recentSales: { value, error: null, fresh: true } }));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setState((s) => ({ ...s, recentSales: { value: null, error: err, fresh: true } }));
        });
    }

    return () => {
      cancelled = true;
      // Reset the budget so the timer is cleared even if an aborted
      // controller is still in flight inside the bridge.
      budget.reset();
    };
  }, [accountId, itemId, excludeTrxId, prefs.showRecentSales]);

  useEffect(() => {
    return load();
  }, [load]);

  // Demand depends on the resolved header.available; fire it independently
  // once we know the available qty. Keeping this in its own effect avoids
  // re-running the entire load() pipeline just because demand is gated by
  // a value that arrives partway through.
  useEffect(() => {
    if (!prefs.showDemand) return undefined;
    const header = state.header.value;
    if (header === null) return undefined;
    let cancelled = false;
    // Demand has its own per-query timeout; we share a one-off mini-budget
    // here only to keep the metric path honest. The popup-level budget is
    // already torn down by the time this effect runs in most flows.
    const localBudget = createQueryBudget();
    const handle = localBudget.acquire("demand");
    runItemDemandQuery(itemId, header.qavail, handle.controller.signal)
      .then((value) => {
        handle.signalDone(true, false);
        if (cancelled) return;
        setState((s) => ({ ...s, demand: { value, error: null, fresh: true } }));
      })
      .catch((err: unknown) => {
        const isAbort =
          err instanceof DOMException &&
          err.name === "AbortError" &&
          handle.controller.signal.aborted;
        handle.signalDone(false, isAbort);
        if (cancelled) return;
        setState((s) => ({ ...s, demand: { value: null, error: err, fresh: true } }));
      });
    return () => {
      cancelled = true;
      localBudget.reset();
    };
  }, [itemId, prefs.showDemand, state.header.value]);

  const headerError = state.header.error;
  // Header is "blocking" because the rest of the popup depends on the
  // item identity and totals; if it failed and we have nothing to show,
  // render the centralised error UI instead.
  if (headerError !== null && state.header.value === null) {
    const code = mapSuiteQLError(headerError);
    const ui = errorUI(code);
    return (
      <ErrorState
        message={ui.message}
        showRetry={ui.showRetry}
        onRetry={() => {
          // Drop any L1 entry so retry doesn't dedup against the previous
          // failure. PersistentCache doesn't expose delete; we evict L1
          // through the underlying LRUCache instance instead.
          l1ItemHeader.delete(itemHeaderCacheKey(accountId, itemId));
          load();
        }}
      />
    );
  }

  // Header still loading: skeleton popup. We don't show a full skeleton
  // for all three sections because that's busy; instead, render the
  // header skeleton and stat cards, then let the location/receipt
  // sections fade in as they arrive.
  if (state.header.value === null) {
    return (
      <div
        className="nsl-popup"
        // biome-ignore lint/a11y/useSemanticElements: see note in ErrorState.
        role="dialog"
        aria-label="Stock Lens loading"
      >
        <div className="nsl-popup__header">
          <div className="nsl-popup__title">Stock Lens</div>
        </div>
        <div className="nsl-popup__stats">
          <div className="nsl-popup__loading-cell" />
          <div className="nsl-popup__loading-cell" />
          <div className="nsl-popup__loading-cell" />
          <div className="nsl-popup__loading-cell" />
        </div>
      </div>
    );
  }

  const data = state.header.value;
  const isNonInventory =
    typeof data.itemtype === "string" && NON_INVENTORY_TYPES.has(data.itemtype);
  const allZero = data.qoh === 0 && data.qcom === 0 && data.qavail === 0 && data.qord === 0;
  const showEmpty = isNonInventory && allZero;

  // In list-view mode the badge is always hidden — `lineQty` is
  // already forced to null above, but we also short-circuit here so a future
  // change to `badgeColor` cannot accidentally re-introduce a colour.
  const badge: BadgeColor = listViewMode ? "hidden" : badgeColor(data.qavail, lineQty);

  const locations = state.locations.value;
  const locationsErrored = state.locations.error !== null;
  // Display order: locations with stock first (on hand desc, then available desc),
  // then alphabetical for the tie. Rows with both qoh and qavail at 0 add noise
  // in accounts with many warehouses, so we hide them — the totals card already
  // tells the user there's no stock anywhere.
  const sortedLocations = locations
    ? locations
        .filter((l) => l.quantityonhand !== 0 || l.quantityavailable !== 0)
        .slice()
        .sort((a, b) => {
          if (b.quantityonhand !== a.quantityonhand) {
            return b.quantityonhand - a.quantityonhand;
          }
          if (b.quantityavailable !== a.quantityavailable) {
            return b.quantityavailable - a.quantityavailable;
          }
          return (a.locationname || a.location).localeCompare(b.locationname || b.location);
        })
    : [];
  const visibleLocations = sortedLocations.slice(0, MAX_LOCATIONS_VISIBLE);
  const moreLocations = Math.max(0, sortedLocations.length - MAX_LOCATIONS_VISIBLE);

  const receipts = state.nextReceipts.value;
  const receiptsErrored = state.nextReceipts.error !== null;
  const visibleReceipts = receipts ? receipts.slice(0, MAX_RECEIPTS_VISIBLE) : [];

  // Cross-record visibility. Both off -> base layout (no tab UI, no
  // extra section). Exactly one on -> render that section inline without
  // tab chrome. Both on -> tab UI with default landing on recent-sales.
  const showRecentSales = prefs.showRecentSales;
  const showDemand = prefs.showDemand;
  const showTabs = showRecentSales && showDemand;
  const showInlineRecentSales = showRecentSales && !showTabs;
  const showInlineDemand = showDemand && !showTabs;

  return (
    <div
      className="nsl-popup"
      // biome-ignore lint/a11y/useSemanticElements: see note in ErrorState.
      role="dialog"
      aria-label="Stock Lens"
    >
      <div className="nsl-popup__header">
        <div className="nsl-popup__title">Stock Lens</div>
        {badge !== "hidden" ? (
          <span
            className={`nsl-popup__badge nsl-popup__badge--${badge}`}
            aria-label={`Stock status: ${badge}`}
          >
            {badge === "green" ? "OK" : badge === "yellow" ? "Low" : "Out"}
          </span>
        ) : null}
      </div>

      {showEmpty ? (
        <div className="nsl-popup__empty">No inventory tracked</div>
      ) : (
        <div className="nsl-popup__stats">
          <div className="nsl-popup__stat">
            <div className="nsl-popup__stat-label">On hand</div>
            <div className="nsl-popup__stat-value">{formatQty(data.qoh)}</div>
          </div>
          <div className="nsl-popup__stat">
            <div className="nsl-popup__stat-label">Committed</div>
            <div className="nsl-popup__stat-value">{formatQty(data.qcom)}</div>
          </div>
          <div className="nsl-popup__stat">
            <div className="nsl-popup__stat-label">Available</div>
            <div className="nsl-popup__stat-value">{formatQty(data.qavail)}</div>
          </div>
          <div className="nsl-popup__stat">
            <div className="nsl-popup__stat-label">On order</div>
            <div className="nsl-popup__stat-value">{formatQty(data.qord)}</div>
          </div>
        </div>
      )}

      {/* By location section: only render when at least one location has stock. */}
      {sortedLocations.length > 0 ? (
        <div className="nsl-popup__section">
          <div className="nsl-popup__section-title">By location</div>
          <div className="nsl-popup__locations-scroll">
            <table className="nsl-popup__locations">
              <thead>
                <tr>
                  <th>Location</th>
                  <th>On hand</th>
                  <th>Available</th>
                </tr>
              </thead>
              <tbody>
                {visibleLocations.map((loc) => (
                  <tr key={loc.location}>
                    <td>{loc.locationname || `#${loc.location}`}</td>
                    <td>{formatQty(loc.quantityonhand)}</td>
                    <td>{formatQty(loc.quantityavailable)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {moreLocations > 0 ? (
            <div className="nsl-popup__locations-more">+ {moreLocations} more</div>
          ) : null}
        </div>
      ) : locationsErrored ? (
        <div className="nsl-popup__section">
          <div className="nsl-popup__section-note">location breakdown unavailable</div>
        </div>
      ) : null}

      {/* Next receipt section. */}
      {receipts !== null && receipts.length > 0 ? (
        <div className="nsl-popup__section">
          <div className="nsl-popup__section-title">Next receipt</div>
          {visibleReceipts.map((r) => (
            <div className="nsl-popup__receipt" key={r.trxid}>
              <span className="nsl-popup__receipt-vendor">{r.vendor || "—"}</span>
              <span className="nsl-popup__receipt-qty">{formatQty(r.quantity)} units</span>
              <span className="nsl-popup__receipt-date">{formatDueDate(r.duedate)}</span>
            </div>
          ))}
        </div>
      ) : receiptsErrored ? (
        <div className="nsl-popup__section">
          <div className="nsl-popup__section-note">next receipt unavailable</div>
        </div>
      ) : null}

      {/* Single inline cross-record section (only when exactly one opt-in is on). */}
      {showInlineRecentSales ? <RecentSalesSection sales={state.recentSales} /> : null}
      {showInlineDemand ? <DemandSection demand={state.demand} /> : null}

      {/* Tabbed footer (only when both opt-ins are on). */}
      {showTabs ? (
        <div className="nsl-popup__section">
          <div className="nsl-popup__tabs" role="tablist" aria-label="Cross-record data">
            <TabButton
              label="Inventory"
              active={activeTab === "inventory"}
              onClick={() => setActiveTab("inventory")}
            />
            <TabButton
              label="Recent sales"
              active={activeTab === "recent-sales"}
              onClick={() => setActiveTab("recent-sales")}
            />
            <TabButton
              label="Demand"
              active={activeTab === "demand"}
              onClick={() => setActiveTab("demand")}
            />
          </div>
          <div className="nsl-popup__tab-body" role="tabpanel">
            {activeTab === "inventory" ? (
              <div className="nsl-popup__section-note">(inventory shown above)</div>
            ) : null}
            {activeTab === "recent-sales" ? <RecentSalesBody sales={state.recentSales} /> : null}
            {activeTab === "demand" ? <DemandBody demand={state.demand} /> : null}
          </div>
        </div>
      ) : null}

      {state.refreshing ? (
        <div className="nsl-popup__footer">
          <span className="nsl-popup__refreshing" aria-live="polite">
            <span className="nsl-popup__refreshing-dot" /> refreshing…
          </span>
        </div>
      ) : null}
    </div>
  );
}

interface TabButtonProps {
  label: string;
  active: boolean;
  onClick(): void;
}

function TabButton({ label, active, onClick }: TabButtonProps): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`nsl-popup__tab${active ? " nsl-popup__tab--active" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

interface RecentSalesSectionProps {
  sales: SliceState<RecentSale[]>;
}

// Wrapped variant with section title and divider for the inline (single-tab)
// layout. The tabbed variant reuses RecentSalesBody without the title.
function RecentSalesSection({ sales }: RecentSalesSectionProps): JSX.Element {
  return (
    <div className="nsl-popup__section">
      <div className="nsl-popup__section-title">Recent sales</div>
      <RecentSalesBody sales={sales} />
    </div>
  );
}

function RecentSalesBody({ sales }: RecentSalesSectionProps): JSX.Element {
  if (sales.value === null && sales.error !== null) {
    return <div className="nsl-popup__section-note">recent sales unavailable</div>;
  }
  if (sales.value === null) {
    // Loading: render a skeleton row so the tab doesn't visibly empty.
    return <div className="nsl-popup__section-note">loading…</div>;
  }
  if (sales.value.length === 0) {
    return <div className="nsl-popup__section-note">no recent sales</div>;
  }
  const rows = sales.value.slice(0, MAX_SALES_VISIBLE);
  return (
    <table className="nsl-popup__recent-sales">
      <thead>
        <tr>
          <th>Customer</th>
          <th>Qty</th>
          <th>Rate</th>
          <th>Date</th>
          <th>Type</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => (
          <tr key={`${s.tranid}-${s.trandate ?? ""}`}>
            <td>{s.customer || "—"}</td>
            <td>{formatQty(s.quantity)}</td>
            <td>{formatRate(s.rate)}</td>
            <td>{formatDueDate(s.trandate)}</td>
            <td>
              <span className="nsl-popup__sale-type-chip">{saleTypeLabel(s.type)}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface DemandSectionProps {
  demand: SliceState<DemandResult>;
}

function DemandSection({ demand }: DemandSectionProps): JSX.Element {
  return (
    <div className="nsl-popup__section">
      <div className="nsl-popup__section-title">Demand</div>
      <DemandBody demand={demand} />
    </div>
  );
}

function DemandBody({ demand }: DemandSectionProps): JSX.Element {
  if (demand.value === null && demand.error !== null) {
    return <div className="nsl-popup__section-note">demand data unavailable</div>;
  }
  if (demand.value === null) {
    return <div className="nsl-popup__section-note">loading…</div>;
  }
  const r = demand.value;
  // Each kind renders distinctly: ok shows two metrics, the others fall back
  // to a single friendly note. Avg daily is always shown when the query
  // resolved (even the "no-demand" case can carry it; it'll just be 0).
  return (
    <div className="nsl-popup__demand">
      <div className="nsl-popup__demand-metric">
        <span className="nsl-popup__stat-label">Avg daily</span>
        <span className="nsl-popup__stat-value">
          {formatQty(r.avgDailyDemand)} <span style={{ fontSize: "11px" }}>/ day</span>
        </span>
      </div>
      {r.kind === "ok" ? (
        <div className="nsl-popup__demand-metric">
          <span className="nsl-popup__stat-label">Days of stock</span>
          <span className="nsl-popup__stat-value">{r.daysOfStock}</span>
        </div>
      ) : null}
      {r.kind === "no-demand" ? (
        <div className="nsl-popup__demand-note">no recent demand</div>
      ) : null}
      {r.kind === "backordered" ? <div className="nsl-popup__demand-note">backordered</div> : null}
      {r.kind === "unavailable" ? (
        <div className="nsl-popup__demand-note">no demand data</div>
      ) : null}
    </div>
  );
}
