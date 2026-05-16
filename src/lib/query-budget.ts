/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Per-hover query budget coordinator.
//
// Why this exists: a hover with all cross-record features enabled fans out up to
// four parallel SuiteQL queries (header, locations, next-receipts, plus
// either recent-sales or demand). NetSuite SuiteQL p95 can spike under load,
// and even though each query has its own 2000 ms timeout, a single stall
// would block the popup from rendering the slices that already finished.
// The budget keeps popup latency predictable: when the total budget
// (3000 ms) elapses the budget coordinator aborts whatever is still pending and
// renders a partial popup with whatever resolved in time.
//
// Per-query timeout: 2000 ms (callers pass this to runSuiteQL).
// Total budget per hover: 3000 ms — a fresh AbortController fires at that
// point. Callers compose the budget's signal with their own per-query
// AbortController so a budget timeout cancels all pending fetches at once.
//
// Internal telemetry counters track totalQueries, timedOutQueries, and
// partialRenders. They are not exposed externally yet; a future pass may wire
// them into a telemetry pipeline once the telemetry decision is made.

export const PER_QUERY_TIMEOUT_MS = 2000;
export const TOTAL_BUDGET_MS = 3000;

export interface BudgetMetrics {
  totalQueries: number;
  timedOutQueries: number;
  // Hover sessions where at least one query timed out before reset (i.e.,
  // the popup rendered a partial view). Incremented at reset() time so each
  // call to reset() that follows ≥1 timeout bumps this by one.
  partialRenders: number;
}

export interface AcquireHandle {
  // Composable AbortController. The signal fires when either:
  //   1. The total budget elapses (the shared timer fires).
  //   2. The caller manually aborts the controller they receive.
  // Callers should pass `controller.signal` into their query wrappers and
  // call `signalDone(success, timedOut)` exactly once when the query
  // settles so the metrics counters stay accurate.
  controller: AbortController;
  signalDone(success: boolean, timedOut: boolean): void;
}

export interface QueryBudget {
  // Returns a fresh AbortController whose signal fires when the budget
  // expires (or when the caller manually aborts). `queryType` is recorded
  // for future telemetry differentiation but does not affect behaviour.
  acquire(queryType: string): AcquireHandle;
  // Snapshot — read-only.
  metrics(): Readonly<BudgetMetrics>;
  // For tests: clears counters and the shared budget timer. The next
  // `acquire` call starts a new budget window.
  reset(): void;
}

interface InternalState {
  budgetTimer: ReturnType<typeof setTimeout> | null;
  // The single "session" controller: a hover starts a budget by acquiring
  // its first query, which arms the timer. Every subsequent acquire in the
  // same session listens on the same timer. We do not share the
  // AbortController across queries — callers each get their own so they
  // can abort one without aborting the others — but the budget timer
  // aborts ALL of them when it fires.
  activeControllers: Set<AbortController>;
  sessionHadTimeout: boolean;
  metrics: BudgetMetrics;
}

export function createQueryBudget(totalBudgetMs: number = TOTAL_BUDGET_MS): QueryBudget {
  const state: InternalState = {
    budgetTimer: null,
    activeControllers: new Set(),
    sessionHadTimeout: false,
    metrics: {
      totalQueries: 0,
      timedOutQueries: 0,
      partialRenders: 0,
    },
  };

  function armBudgetTimer(): void {
    if (state.budgetTimer !== null) return;
    state.budgetTimer = setTimeout(() => {
      // Budget expired: abort every still-pending controller. Each caller's
      // signalDone will mark the query as a timeout when it observes the
      // abort, so we don't need to bump timedOutQueries here ourselves.
      for (const controller of state.activeControllers) {
        // Reason string mirrors DOMException("aborted","AbortError") for
        // consistency with the bridge's existing abort handling.
        controller.abort(new DOMException("budget-expired", "AbortError"));
      }
      // Don't clear activeControllers — signalDone uses presence to
      // decide whether the timeout came from us vs an external abort.
      state.budgetTimer = null;
    }, totalBudgetMs);
  }

  function clearBudgetTimer(): void {
    if (state.budgetTimer !== null) {
      clearTimeout(state.budgetTimer);
      state.budgetTimer = null;
    }
  }

  return {
    acquire(_queryType: string): AcquireHandle {
      state.metrics.totalQueries += 1;
      armBudgetTimer();
      const controller = new AbortController();
      state.activeControllers.add(controller);

      let settled = false;
      return {
        controller,
        signalDone(_success: boolean, timedOut: boolean): void {
          if (settled) return;
          settled = true;
          state.activeControllers.delete(controller);
          if (timedOut) {
            state.metrics.timedOutQueries += 1;
            state.sessionHadTimeout = true;
          }
          // If no queries are still pending, the budget can shut down
          // its timer to avoid leaking timers between hover sessions.
          if (state.activeControllers.size === 0) {
            clearBudgetTimer();
          }
        },
      };
    },

    metrics(): Readonly<BudgetMetrics> {
      // Defensive copy: tests should not be able to mutate the live
      // counters through the returned object.
      return { ...state.metrics };
    },

    reset(): void {
      // Record a partial render if the session that's ending had any
      // queries time out, THEN clear the per-session counters. We zero
      // every counter (including partialRenders) so reset() doubles as a
      // test-isolation hook; callers that want cumulative partialRenders
      // across sessions should observe the counter via `metrics()` before
      // calling `reset()`.
      if (state.sessionHadTimeout) {
        state.metrics.partialRenders += 1;
      }
      state.metrics.totalQueries = 0;
      state.metrics.timedOutQueries = 0;
      state.metrics.partialRenders = 0;
      state.sessionHadTimeout = false;
      // Abort any still-pending controllers so they don't outlive the
      // session — a stale controller could otherwise resolve into a
      // discarded popup render.
      for (const controller of state.activeControllers) {
        if (!controller.signal.aborted) {
          controller.abort(new DOMException("budget-reset", "AbortError"));
        }
      }
      state.activeControllers.clear();
      clearBudgetTimer();
    },
  };
}
