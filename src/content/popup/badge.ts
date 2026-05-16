/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Maps "available stock" vs "line quantity" to a coloured status badge.
//
// The badge answers the question: "If I commit this line right now, do I
// have enough on-hand to fulfill it?" Comparison is against the aggregate
// `available` total (across all locations). When the user can't be matched
// to a line quantity at all (e.g. hovering an item link outside a
// transaction line), the badge is suppressed; rendering green/red without
// context is more misleading than helpful.

export type BadgeColor = "red" | "yellow" | "green" | "hidden";

export function badgeColor(available: number, lineQty: number | null): BadgeColor {
  if (lineQty === null) return "hidden";
  if (available <= 0) return "red";
  if (available < lineQty) return "yellow";
  return "green";
}
