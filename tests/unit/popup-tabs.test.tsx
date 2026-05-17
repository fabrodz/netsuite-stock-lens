/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { __resetChromeStorage, __setChromeSyncValue } from "../setup";

// The popup imports a lot of side-effecting modules (persistent cache,
// shadow-DOM mount, bridge). For a focused tab-visibility test we mock
// every data source and the cache so the render path is deterministic and
// fast. The component still exercises the full conditional rendering
// logic we care about.

vi.mock("@/lib/persistent-cache", async (importOriginal) => {
  const actual: typeof import("@/lib/persistent-cache") = await importOriginal();
  return {
    ...actual,
    // Replace PersistentCache with a stub whose fetchSWR resolves
    // synchronously to the canned header. Calling the onValue callback
    // mirrors the "fresh" emission contract so the component leaves its
    // loading state on the first effect tick.
    PersistentCache: class {
      async fetchSWR<T>(
        _key: string,
        fetcher: () => Promise<T>,
        onValue: (value: T, status: string) => void,
      ): Promise<void> {
        const value = await fetcher();
        onValue(value, "fresh-l1");
      }
    },
  };
});

vi.mock("@/lib/queries/itemHeader", () => ({
  ItemHeaderSchema: { parse: (x: unknown) => x },
  runItemHeaderQuery: vi.fn(async () => ({
    id: "1",
    itemid: "WIDGET-1",
    displayname: "Widget One",
    itemtype: "InvtPart",
    qoh: 10,
    qcom: 2,
    qavail: 8,
    qord: 0,
    qbo: 0,
  })),
}));

vi.mock("@/lib/queries/itemLocations", () => ({
  runItemLocationsQuery: vi.fn(async () => []),
}));

vi.mock("@/lib/queries/itemNextReceipt", () => ({
  runItemNextReceiptQuery: vi.fn(async () => []),
}));

vi.mock("@/lib/queries/itemRecentSales", () => ({
  runItemRecentSalesQuery: vi.fn(async () => [
    {
      tranid: "INV1",
      trandate: "2026-05-01",
      customer: "Acme",
      quantity: 1,
      rate: 9.99,
      type: "CustInvc",
    },
  ]),
}));

vi.mock("@/lib/queries/itemDemand", () => ({
  runItemDemandQuery: vi.fn(async () => ({
    kind: "ok",
    avgDailyDemand: 1,
    daysOfStock: 8,
  })),
}));

vi.mock("@/content/line-quantity", () => ({
  findLineQuantity: vi.fn(() => null),
}));

// HoverPopup must be imported AFTER the mocks are registered so the
// module graph resolves to the stubs.
import { HoverPopup } from "@/content/popup/HoverPopup";
import { PREFERENCES_STORAGE_KEY } from "@/lib/preferences";

function makeAnchor(): HTMLElement {
  const a = document.createElement("a");
  document.body.appendChild(a);
  return a;
}

function setPrefs(prefs: {
  showRecentSales: boolean;
  showDemand: boolean;
}): void {
  __setChromeSyncValue(PREFERENCES_STORAGE_KEY, {
    enabled: true,
    triggerMode: "shift-hover",
    hoverDelayMs: 400,
    showRecentSales: prefs.showRecentSales,
    showDemand: prefs.showDemand,
  });
}

beforeEach(() => {
  __resetChromeStorage();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("HoverPopup cross-record tabs", () => {
  test("both opt-ins off: renders no tab UI and no extra section", async () => {
    setPrefs({ showRecentSales: false, showDemand: false });
    render(
      <HoverPopup itemId="1" accountId="1234567" anchor={makeAnchor()} onClose={() => undefined} />,
    );
    // Wait for the header to render so we know loading is done.
    await waitFor(() => expect(screen.getByText("Stock Lens")).toBeTruthy());
    // Tab list should not render. The base inventory layout still does.
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab", { name: /recent sales/i })).toBeNull();
    expect(screen.queryByRole("tab", { name: /demand/i })).toBeNull();
    // Recent sales / demand section titles should NOT be present.
    expect(screen.queryByText(/recent sales/i)).toBeNull();
    expect(screen.queryByText(/^Demand$/i)).toBeNull();
  });

  test("only showRecentSales on: renders inline section, no tab UI", async () => {
    setPrefs({ showRecentSales: true, showDemand: false });
    render(
      <HoverPopup itemId="1" accountId="1234567" anchor={makeAnchor()} onClose={() => undefined} />,
    );
    await waitFor(() => expect(screen.getByText("Stock Lens")).toBeTruthy());
    // Inline section title rendered.
    await waitFor(() => expect(screen.getByText(/recent sales/i)).toBeTruthy());
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText(/^Demand$/i)).toBeNull();
  });

  test("only showDemand on: renders inline section, no tab UI", async () => {
    setPrefs({ showRecentSales: false, showDemand: true });
    render(
      <HoverPopup itemId="1" accountId="1234567" anchor={makeAnchor()} onClose={() => undefined} />,
    );
    await waitFor(() => expect(screen.getByText("Stock Lens")).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/^Demand$/i)).toBeTruthy());
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText(/recent sales/i)).toBeNull();
  });

  test("both opt-ins on: renders tab UI with Recent sales as default", async () => {
    setPrefs({ showRecentSales: true, showDemand: true });
    render(
      <HoverPopup itemId="1" accountId="1234567" anchor={makeAnchor()} onClose={() => undefined} />,
    );
    // Wait for the loaded state directly. The header text "Stock Lens"
    // is present even in the loading skeleton, so we need to anchor on
    // something that only appears once the data finishes resolving. The
    // 3 s timeout cushions slower CI runners where React + jsdom can
    // take longer than the testing-library default to converge.
    const tablist = await screen.findByRole("tablist", {}, { timeout: 3000 });
    expect(tablist).toBeTruthy();
    // All three tabs render. Use findByRole so each lookup retries
    // until present rather than failing synchronously on a mid-render.
    const inventoryTab = await screen.findByRole("tab", { name: /inventory/i });
    const recentSalesTab = await screen.findByRole("tab", { name: /recent sales/i });
    const demandTab = await screen.findByRole("tab", { name: /demand/i });
    // Recent sales should be selected by default.
    expect(recentSalesTab.getAttribute("aria-selected")).toBe("true");
    expect(inventoryTab.getAttribute("aria-selected")).toBe("false");
    expect(demandTab.getAttribute("aria-selected")).toBe("false");
  });
});
