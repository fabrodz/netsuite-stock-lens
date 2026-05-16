/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Line-quantity extraction for the hover popup badge.
//
// The popup colour-codes "available vs line quantity" so the user sees at a
// glance whether the inventory covers the line they're about to commit to.
// To do that we need to find the quantity field for the row that contains
// the hovered item link. NetSuite renders transaction lines in several
// shapes across surfaces (classic uir-list-row tables, Redwood data grids,
// and the older sublist HTML on edit pages), so we try heuristics in order
// rather than locking to one selector.
//
// Heuristics (applied in order, first match wins):
//   1. Walk up from `anchor` via closest("tr") to find the containing row.
//      Falls back to closest("[role='row']") (Redwood), then to
//      closest(".uir-list-row-tr") (NetSuite classic list-row).
//   2. Inside the row, search for an input whose name or id matches the
//      classic quantity field patterns:
//        - name === "quantity" or "quantity1".."quantity9"
//        - id matches /^inpt_quantity\d+_\d+$/
//      If found, parse Number(input.value).
//   3. If no input matches, look for the cell whose preceding column header
//      text reads "Quantity" (case-insensitive). Classic tables expose
//      td.uir-list-cell with a sibling header row at the top of the table;
//      we walk the table for that header text and pick the matching cell in
//      the row.
//
// Edge cases:
//   - Returns null if the row can't be found, the value is missing, the
//     value parses as NaN, or the value is <= 0. Zero/negative line
//     quantities are treated as "not present" because they produce a
//     misleading badge ("green: 0 needed").
//   - Defensive null checks at every property access: NetSuite occasionally
//     re-renders rows in place which detaches inputs from their parents.

const QUANTITY_NAME_PATTERN = /^quantity\d?$/;
const QUANTITY_ID_PATTERN = /^inpt_quantity\d+_\d+$/;

// Find the closest ancestor row container for the hovered anchor.
function findRowContainer(anchor: HTMLElement): HTMLElement | null {
  // closest() handles the case where `anchor` itself is a row (rare but
  // possible if the caller passes a row container directly).
  const tr = anchor.closest("tr");
  if (tr instanceof HTMLElement) return tr;
  const roleRow = anchor.closest("[role='row']");
  if (roleRow instanceof HTMLElement) return roleRow;
  const classicRow = anchor.closest(".uir-list-row-tr");
  if (classicRow instanceof HTMLElement) return classicRow;
  return null;
}

// Parses a raw string into a positive number, or null if it's missing,
// NaN, or non-positive.
function parsePositive(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // NetSuite occasionally includes a thousands separator on display values
  // (e.g. "1,200"). Strip commas before parsing; this is safe for both en
  // and es locales because we only support latin-script digits here.
  const cleaned = trimmed.replace(/,/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;
  return n;
}

// Scans the row for a quantity input. Returns the input's value, or null.
function findQuantityInputValue(row: HTMLElement): string | null {
  const inputs = row.querySelectorAll<HTMLInputElement>("input");
  for (const input of inputs) {
    if (!(input instanceof HTMLInputElement)) continue;
    const name = input.getAttribute("name");
    const id = input.getAttribute("id");
    const nameMatches = name !== null && QUANTITY_NAME_PATTERN.test(name);
    const idMatches = id !== null && QUANTITY_ID_PATTERN.test(id);
    if (!nameMatches && !idMatches) continue;
    // input.value is "" for empty fields; we treat that as "no qty entered".
    return input.value ?? null;
  }
  return null;
}

// Finds the column index whose header text reads "Quantity". Returns -1 if
// no such column exists.
function findQuantityColumnIndex(row: HTMLElement): number {
  // The row's owning table gives us the header row. NetSuite's classic
  // sublist puts headers in a separate <tr class="uir-list-header"> or
  // similar; we walk the table to find any <th> or header-style cell whose
  // text is "Quantity".
  const table = row.closest("table");
  if (table === null) return -1;
  // Prefer <th> first; fall back to td cells in a header row.
  const headerCells = table.querySelectorAll<HTMLElement>("th, .uir-list-headercell");
  for (let i = 0; i < headerCells.length; i += 1) {
    const cell = headerCells[i];
    if (cell === undefined) continue;
    const text = (cell.textContent ?? "").trim().toLowerCase();
    if (text === "quantity") {
      // Convert the absolute cell index into a column index by counting
      // sibling header cells before this one within the same parent row.
      const parent = cell.parentElement;
      if (parent === null) return -1;
      const siblings = parent.children;
      for (let j = 0; j < siblings.length; j += 1) {
        if (siblings[j] === cell) return j;
      }
      return -1;
    }
  }
  return -1;
}

// Reads textContent from the row's nth cell. Returns null if the cell is
// missing or empty.
function readCellText(row: HTMLElement, columnIndex: number): string | null {
  if (columnIndex < 0) return null;
  const cells = row.children;
  const cell = cells[columnIndex];
  if (!(cell instanceof HTMLElement)) return null;
  return cell.textContent;
}

export function findLineQuantity(anchor: HTMLElement): number | null {
  if (!(anchor instanceof HTMLElement)) return null;
  const row = findRowContainer(anchor);
  if (row === null) return null;

  // Strategy 1: quantity input inside the row.
  const inputValue = findQuantityInputValue(row);
  const fromInput = parsePositive(inputValue);
  if (fromInput !== null) return fromInput;

  // Strategy 2: header-driven column lookup.
  const columnIndex = findQuantityColumnIndex(row);
  const cellText = readCellText(row, columnIndex);
  const fromCell = parsePositive(cellText);
  if (fromCell !== null) return fromCell;

  return null;
}
