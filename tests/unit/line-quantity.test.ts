/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { findLineQuantity } from "@/content/line-quantity";
import { afterEach, describe, expect, test } from "vitest";

afterEach(() => {
  document.body.innerHTML = "";
});

// Helper: builds a classic-shaped <table> with a header row and one data row.
// Returns the anchor inside the data row so tests can drive findLineQuantity
// with the same DOM shape NetSuite uses on transaction edit pages.
function buildClassicRow(opts: {
  qty?: string;
  inputName?: string;
  inputId?: string;
  cellQtyText?: string;
}): HTMLElement {
  const table = document.createElement("table");
  // Header row: Item | Quantity | Description
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  for (const label of ["Item", "Quantity", "Description"]) {
    const th = document.createElement("th");
    th.textContent = label;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const row = document.createElement("tr");
  // Item cell with the anchor
  const itemCell = document.createElement("td");
  const anchor = document.createElement("a");
  anchor.href = "/app/common/item/item.nl?id=1";
  anchor.textContent = "ITEM-1";
  itemCell.appendChild(anchor);
  row.appendChild(itemCell);

  // Quantity cell
  const qtyCell = document.createElement("td");
  if (opts.qty !== undefined) {
    const input = document.createElement("input");
    input.setAttribute("type", "hidden");
    input.setAttribute("name", opts.inputName ?? "quantity");
    if (opts.inputId) input.setAttribute("id", opts.inputId);
    input.value = opts.qty;
    qtyCell.appendChild(input);
  }
  if (opts.cellQtyText !== undefined) {
    qtyCell.appendChild(document.createTextNode(opts.cellQtyText));
  }
  row.appendChild(qtyCell);

  // Description cell
  const descCell = document.createElement("td");
  descCell.textContent = "Some description";
  row.appendChild(descCell);

  tbody.appendChild(row);
  table.appendChild(tbody);
  document.body.appendChild(table);
  return anchor;
}

describe("findLineQuantity", () => {
  test("reads the value from a hidden quantity input in the same <tr>", () => {
    const anchor = buildClassicRow({ qty: "5", inputName: "quantity" });
    expect(findLineQuantity(anchor)).toBe(5);
  });

  test("supports indexed input names like quantity1..quantity9", () => {
    const anchor = buildClassicRow({ qty: "12", inputName: "quantity3" });
    expect(findLineQuantity(anchor)).toBe(12);
  });

  test("supports the inpt_quantityN_M id pattern", () => {
    // No `name` attribute: matches purely on id.
    const anchor = buildClassicRow({
      qty: "7",
      inputName: "ignoredname",
      inputId: "inpt_quantity12_4",
    });
    expect(findLineQuantity(anchor)).toBe(7);
  });

  test("falls back to the Quantity column cell text when no input matches", () => {
    const anchor = buildClassicRow({ cellQtyText: "  3  " });
    expect(findLineQuantity(anchor)).toBe(3);
  });

  test("strips thousands commas before parsing", () => {
    const anchor = buildClassicRow({ qty: "1,200" });
    expect(findLineQuantity(anchor)).toBe(1200);
  });

  test("returns null when the anchor has no surrounding row", () => {
    const orphan = document.createElement("a");
    orphan.href = "/app/common/item/item.nl?id=1";
    document.body.appendChild(orphan);
    expect(findLineQuantity(orphan)).toBeNull();
  });

  test("returns null when the quantity is NaN (non-numeric text)", () => {
    const anchor = buildClassicRow({ qty: "abc" });
    expect(findLineQuantity(anchor)).toBeNull();
  });

  test("returns null when the quantity is zero", () => {
    const anchor = buildClassicRow({ qty: "0" });
    expect(findLineQuantity(anchor)).toBeNull();
  });

  test("returns null when the quantity is negative", () => {
    const anchor = buildClassicRow({ qty: "-2" });
    expect(findLineQuantity(anchor)).toBeNull();
  });

  test("resolves a nested anchor (anchor inside a span inside a link) up to the row", () => {
    const anchor = buildClassicRow({ qty: "4" });
    // Wrap the anchor's content in a <span> so the hovered element is one
    // level deeper than the direct link.
    const span = document.createElement("span");
    span.textContent = anchor.textContent;
    anchor.textContent = "";
    anchor.appendChild(span);
    // Pass the span (the hovered element) rather than the anchor.
    expect(findLineQuantity(span)).toBe(4);
  });

  test("works with role='row' Redwood-style containers", () => {
    const row = document.createElement("div");
    row.setAttribute("role", "row");
    const input = document.createElement("input");
    input.setAttribute("name", "quantity1");
    input.value = "9";
    row.appendChild(input);
    const anchor = document.createElement("a");
    anchor.href = "/app/common/item/item.nl?id=1";
    row.appendChild(anchor);
    document.body.appendChild(row);
    expect(findLineQuantity(anchor)).toBe(9);
  });
});
