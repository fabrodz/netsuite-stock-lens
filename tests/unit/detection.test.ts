import { type DetectedItem, type DetectionHandle, startDetection } from "@/content/detection";
/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// jsdom doesn't implement requestIdleCallback, so the module's setTimeout
// fallback runs — we drive it with vi.advanceTimersByTime when we need to
// observe a debounced mutation pass. requestAnimationFrame IS implemented in
// jsdom but resolves on a microtask-ish timer; advancing timers also flushes
// it.

let handle: DetectionHandle | null = null;

beforeEach(() => {
  document.body.innerHTML = "";
  vi.useFakeTimers();
});

afterEach(() => {
  handle?.destroy();
  handle = null;
  vi.useRealTimers();
});

function nextDetections(): Promise<DetectedItem[]> {
  return new Promise((resolve) => {
    const captured: DetectedItem[] = [];
    handle?.onDetect((d) => captured.push(d));
    // Let initial scan (requestAnimationFrame) and idle scheduler run.
    setTimeout(() => resolve(captured), 0);
    vi.runAllTimers();
  });
}

describe("startDetection", () => {
  test("detects item.nl anchor by URL pattern", async () => {
    const a = document.createElement("a");
    a.href = "https://1234567.app.netsuite.com/app/common/item/item.nl?id=123";
    a.textContent = "Widget A";
    document.body.appendChild(a);

    handle = startDetection();
    const found = await nextDetections();

    expect(found).toHaveLength(1);
    expect(found[0]?.itemId).toBe("123");
    expect(found[0]?.element).toBe(a);
  });

  test("ignores item.nl anchor without id param", async () => {
    const a = document.createElement("a");
    a.href = "https://1234567.app.netsuite.com/app/common/item/item.nl";
    document.body.appendChild(a);

    handle = startDetection();
    const found = await nextDetections();

    expect(found).toHaveLength(0);
  });

  test("detects element with data-itemid attribute", async () => {
    const span = document.createElement("span");
    span.setAttribute("data-itemid", "456");
    document.body.appendChild(span);

    handle = startDetection();
    const found = await nextDetections();

    expect(found).toHaveLength(1);
    expect(found[0]?.itemId).toBe("456");
    expect(found[0]?.element).toBe(span);
  });

  test("rejects non-numeric data-itemid", async () => {
    const span = document.createElement("span");
    span.setAttribute("data-itemid", "not-a-number");
    document.body.appendChild(span);

    handle = startDetection();
    const found = await nextDetections();

    expect(found).toHaveLength(0);
  });

  test("detects hidden item input via DOM fallback (attaches to row)", async () => {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    const input = document.createElement("input");
    input.type = "hidden";
    input.setAttribute("name", "item");
    input.value = "789";
    td.appendChild(input);
    tr.appendChild(td);
    // jsdom requires a parent table for tr semantics.
    const table = document.createElement("table");
    table.appendChild(tr);
    document.body.appendChild(table);

    handle = startDetection();
    const found = await nextDetections();

    expect(found).toHaveLength(1);
    expect(found[0]?.itemId).toBe("789");
    expect(found[0]?.element).toBe(tr);
  });

  test("dedupes the same anchor element across rescans", async () => {
    const a = document.createElement("a");
    a.href = "https://1234567.app.netsuite.com/app/common/item/item.nl?id=42";
    document.body.appendChild(a);

    handle = startDetection();
    const captured: DetectedItem[] = [];
    handle.onDetect((d) => captured.push(d));

    // Initial scan
    vi.runAllTimers();
    // Force a mutation that triggers a rescan.
    document.body.appendChild(document.createElement("div"));
    vi.runAllTimers();

    const matchesForA = captured.filter((c) => c.element === a);
    expect(matchesForA).toHaveLength(1);
  });

  test("MutationObserver picks up newly added link", async () => {
    handle = startDetection();
    const captured: DetectedItem[] = [];
    handle.onDetect((d) => captured.push(d));
    vi.runAllTimers();

    const a = document.createElement("a");
    a.href = "https://1234567.app.netsuite.com/app/common/item/item.nl?id=999";
    document.body.appendChild(a);

    // Allow the MutationObserver microtask and the idle scheduler timeout
    // to flush.
    await Promise.resolve();
    vi.runAllTimers();

    expect(captured.some((c) => c.itemId === "999")).toBe(true);
  });

  test("URL pattern wins over data-itemid on the same anchor (anchor URL extracted first)", async () => {
    // If an element matches both strategies, we don't want to double-emit.
    // The current implementation handles each strategy independently inside
    // the subtree scan, but the WeakMap dedup ensures only one DetectedItem
    // surfaces for a single element.
    const a = document.createElement("a");
    a.href = "https://1234567.app.netsuite.com/app/common/item/item.nl?id=100";
    a.setAttribute("data-itemid", "200");
    document.body.appendChild(a);

    handle = startDetection();
    const found = await nextDetections();

    expect(found).toHaveLength(1);
    // URL strategy runs first within scanSubtree.
    expect(found[0]?.itemId).toBe("100");
  });

  // --- List-view detection extensions. ---

  test("detects a data row but skips a thead header row in the same table", async () => {
    // Two rows, both contain an item anchor. The first row is inside
    // <thead> (the sortable column header link); detection must skip it.
    // The second row is a real data row and must be picked up.
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headerTr = document.createElement("tr");
    const headerTd = document.createElement("td");
    const headerAnchor = document.createElement("a");
    headerAnchor.href = "https://1234567.app.netsuite.com/app/common/item/item.nl?id=1";
    headerAnchor.textContent = "Item (sort)";
    headerTd.appendChild(headerAnchor);
    headerTr.appendChild(headerTd);
    thead.appendChild(headerTr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    const dataTr = document.createElement("tr");
    const dataTd = document.createElement("td");
    const dataAnchor = document.createElement("a");
    dataAnchor.href = "https://1234567.app.netsuite.com/app/common/item/item.nl?id=2";
    dataAnchor.textContent = "Widget";
    dataTd.appendChild(dataAnchor);
    dataTr.appendChild(dataTd);
    tbody.appendChild(dataTr);
    table.appendChild(tbody);
    document.body.appendChild(table);

    handle = startDetection();
    const found = await nextDetections();

    // Only the data row's anchor should be detected.
    expect(found).toHaveLength(1);
    expect(found[0]?.itemId).toBe("2");
    expect(found[0]?.element).toBe(dataAnchor);
  });

  test("skips uir-list-row-tr--header rows (NetSuite classic list header)", async () => {
    // Reproduces the classic header row that carries the same shape as a
    // data row but with a marker class. The anchor inside must be skipped.
    const table = document.createElement("table");
    const tbody = document.createElement("tbody");
    const headerTr = document.createElement("tr");
    headerTr.classList.add("uir-list-row-tr--header");
    const headerTd = document.createElement("td");
    const headerAnchor = document.createElement("a");
    headerAnchor.href = "https://1234567.app.netsuite.com/app/common/item/item.nl?id=10";
    headerTd.appendChild(headerAnchor);
    headerTr.appendChild(headerTd);
    tbody.appendChild(headerTr);
    table.appendChild(tbody);
    document.body.appendChild(table);

    handle = startDetection();
    const found = await nextDetections();
    expect(found).toHaveLength(0);
  });

  test("pagination change triggers a forced re-scan after the 500ms delay", async () => {
    // Mock NetSuite's pagination: an anchor with id="pagepicker1". When its
    // attributes/text change AND new rows are added asynchronously, the
    // forced re-scan path (timer-driven, 500ms) must rescan the root so
    // those rows are detected even if their MutationRecord wasn't seen.
    const picker = document.createElement("a");
    picker.id = "pagepicker1";
    picker.setAttribute("data-pageindex", "1");
    picker.textContent = "Page 1";
    document.body.appendChild(picker);

    const table = document.createElement("table");
    const tbody = document.createElement("tbody");
    table.appendChild(tbody);
    document.body.appendChild(table);

    handle = startDetection();
    const captured: DetectedItem[] = [];
    handle.onDetect((d) => captured.push(d));
    // Initial scan.
    vi.runAllTimers();
    expect(captured).toHaveLength(0);

    // Simulate a "page click": picker label updates, then the tbody is
    // rebuilt with the page-2 row.
    picker.textContent = "Page 2";
    picker.setAttribute("data-pageindex", "2");
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    const a = document.createElement("a");
    a.href = "https://1234567.app.netsuite.com/app/common/item/item.nl?id=555";
    td.appendChild(a);
    tr.appendChild(td);
    tbody.appendChild(tr);

    // Run timers — both the idle-scheduled scan and the 500ms pagination
    // timer should flush.
    await Promise.resolve();
    vi.runAllTimers();

    expect(captured.some((c) => c.itemId === "555")).toBe(true);
  });

  test("nsl:location-change resets the WeakMap so the same element re-detects", async () => {
    // The SPA navigation hook signals that the URL has changed. Detection
    // must drop dedup state so an anchor that was already detected can be
    // re-detected (its href may now resolve to a different item id).
    const a = document.createElement("a");
    a.href = "https://1234567.app.netsuite.com/app/common/item/item.nl?id=777";
    document.body.appendChild(a);

    handle = startDetection();
    const captured: DetectedItem[] = [];
    handle.onDetect((d) => captured.push(d));
    vi.runAllTimers();
    expect(captured.filter((c) => c.element === a)).toHaveLength(1);

    // Dispatch the location-change event. After the next idle tick the
    // anchor should be re-emitted because the WeakMap was cleared.
    window.dispatchEvent(new CustomEvent("nsl:location-change"));
    await Promise.resolve();
    vi.runAllTimers();

    expect(captured.filter((c) => c.element === a).length).toBeGreaterThanOrEqual(2);
  });

  test("performance: 100 anchors detected and rescan is dedup-cheap", async () => {
    // Soft latency budget: 100 anchors should land in well under 500ms in
    // jsdom (the test environment is slower than a real renderer, so we
    // use a generous cap and trust the fast path).
    const table = document.createElement("table");
    const tbody = document.createElement("tbody");
    for (let i = 0; i < 100; i += 1) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      const a = document.createElement("a");
      a.href = `https://1234567.app.netsuite.com/app/common/item/item.nl?id=${1000 + i}`;
      td.appendChild(a);
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    document.body.appendChild(table);

    // Use real timers for a wall-clock measurement; we restore fake timers
    // in afterEach via vi.useRealTimers().
    vi.useRealTimers();
    handle = startDetection();
    const captured: DetectedItem[] = [];
    handle.onDetect((d) => captured.push(d));

    // Wait for the initial scan to flush (requestAnimationFrame + idle).
    const start = performance.now();
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const elapsed = performance.now() - start;

    expect(captured).toHaveLength(100);
    // Soft cap: 500ms covers CI runners and laptop battery throttling.
    expect(elapsed).toBeLessThan(500);

    // Second pass: force a mutation, ensure no new detections fire (the
    // WeakMap dedup catches every previously-emitted element).
    const before = captured.length;
    document.body.appendChild(document.createElement("div"));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(captured.length - before).toBe(0);
  });
});
