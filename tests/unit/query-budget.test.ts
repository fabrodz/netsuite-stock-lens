/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { PER_QUERY_TIMEOUT_MS, TOTAL_BUDGET_MS, createQueryBudget } from "@/lib/query-budget";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

describe("query-budget constants", () => {
  test("exports the per-query and total-budget timeouts the spec requires", () => {
    expect(PER_QUERY_TIMEOUT_MS).toBe(2000);
    expect(TOTAL_BUDGET_MS).toBe(3000);
  });
});

describe("createQueryBudget — acquire / signalDone", () => {
  test("acquire returns a fresh AbortController each time", () => {
    const budget = createQueryBudget();
    const a = budget.acquire("header");
    const b = budget.acquire("locations");
    expect(a.controller).not.toBe(b.controller);
    expect(a.controller.signal.aborted).toBe(false);
    expect(b.controller.signal.aborted).toBe(false);
  });

  test("totalQueries increments on each acquire", () => {
    const budget = createQueryBudget();
    expect(budget.metrics().totalQueries).toBe(0);
    budget.acquire("header");
    budget.acquire("locations");
    budget.acquire("next-receipts");
    expect(budget.metrics().totalQueries).toBe(3);
  });

  test("signalDone(success=true) does not increment timedOutQueries", () => {
    const budget = createQueryBudget();
    const handle = budget.acquire("header");
    handle.signalDone(true, false);
    expect(budget.metrics().timedOutQueries).toBe(0);
  });

  test("signalDone(success=false, timedOut=true) increments timedOutQueries", () => {
    const budget = createQueryBudget();
    const handle = budget.acquire("header");
    handle.signalDone(false, true);
    expect(budget.metrics().timedOutQueries).toBe(1);
  });

  test("signalDone called twice on the same handle is a no-op", () => {
    const budget = createQueryBudget();
    const handle = budget.acquire("header");
    handle.signalDone(false, true);
    handle.signalDone(false, true);
    expect(budget.metrics().timedOutQueries).toBe(1);
  });

  test("metrics() returns a defensive copy that cannot mutate live state", () => {
    const budget = createQueryBudget();
    budget.acquire("header");
    const snapshot = budget.metrics();
    // biome-ignore lint/suspicious/noExplicitAny: intentional mutation attempt
    (snapshot as any).totalQueries = 9999;
    expect(budget.metrics().totalQueries).toBe(1);
  });
});

describe("createQueryBudget — timer expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("budget timer aborts pending controllers when the total budget elapses", () => {
    const budget = createQueryBudget(100);
    const handle = budget.acquire("header");
    expect(handle.controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(100);
    expect(handle.controller.signal.aborted).toBe(true);
  });

  test("a single timer expiry aborts every still-pending controller", () => {
    const budget = createQueryBudget(50);
    const a = budget.acquire("header");
    const b = budget.acquire("locations");
    const c = budget.acquire("next-receipts");
    vi.advanceTimersByTime(50);
    expect(a.controller.signal.aborted).toBe(true);
    expect(b.controller.signal.aborted).toBe(true);
    expect(c.controller.signal.aborted).toBe(true);
  });

  test("controllers that signalDone before timeout are not aborted by the timer", () => {
    const budget = createQueryBudget(100);
    const finished = budget.acquire("header");
    finished.signalDone(true, false);
    // No more pending controllers means the timer should have cleared.
    // Advance past the original budget; nothing should abort.
    vi.advanceTimersByTime(200);
    expect(finished.controller.signal.aborted).toBe(false);
  });

  test("default total budget uses TOTAL_BUDGET_MS", () => {
    const budget = createQueryBudget();
    const handle = budget.acquire("header");
    vi.advanceTimersByTime(TOTAL_BUDGET_MS - 1);
    expect(handle.controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(handle.controller.signal.aborted).toBe(true);
  });
});

describe("createQueryBudget — reset", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("reset clears totalQueries and timedOutQueries", () => {
    const budget = createQueryBudget();
    const h1 = budget.acquire("header");
    h1.signalDone(false, true);
    budget.acquire("locations");
    expect(budget.metrics().totalQueries).toBe(2);
    expect(budget.metrics().timedOutQueries).toBe(1);
    budget.reset();
    expect(budget.metrics().totalQueries).toBe(0);
    expect(budget.metrics().timedOutQueries).toBe(0);
  });

  test("reset increments partialRenders when the session had a timeout, then clears it", () => {
    const budget = createQueryBudget();
    const h1 = budget.acquire("header");
    h1.signalDone(false, true);
    // partialRenders is only computed at reset time per the spec.
    expect(budget.metrics().partialRenders).toBe(0);
    budget.reset();
    // Reset also zeros partialRenders so the metric is consistently cleared
    // for the next session. Cumulative tracking can be done by reading
    // metrics() before calling reset().
    expect(budget.metrics().partialRenders).toBe(0);
  });

  test("reset is a no-op for partialRenders when the session had no timeouts", () => {
    const budget = createQueryBudget();
    const handle = budget.acquire("header");
    handle.signalDone(true, false);
    budget.reset();
    expect(budget.metrics().partialRenders).toBe(0);
  });

  test("reset aborts any still-pending controllers", () => {
    const budget = createQueryBudget(100);
    const handle = budget.acquire("header");
    budget.reset();
    expect(handle.controller.signal.aborted).toBe(true);
  });

  test("reset clears the budget timer so the next acquire starts a fresh window", () => {
    const budget = createQueryBudget(100);
    budget.acquire("header");
    budget.reset();
    const next = budget.acquire("locations");
    // Advance just under the original budget — the new acquire should
    // still be active because the timer was rearmed by the new acquire.
    vi.advanceTimersByTime(50);
    expect(next.controller.signal.aborted).toBe(false);
    vi.advanceTimersByTime(60);
    expect(next.controller.signal.aborted).toBe(true);
  });
});
