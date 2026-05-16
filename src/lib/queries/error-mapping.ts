/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Centralized "raw SuiteQL error -> friendly code" mapping. The popup UI
// renders human-readable copy keyed off these codes; keeping the mapping in
// one place means changing wording is a one-file change and unit tests can
// cover every branch.
export type FriendlyErrorCode =
  | "inventory-not-enabled"
  | "no-permission"
  | "timeout"
  | "item-not-found"
  | "n-query-unavailable"
  | "unknown";

// Heuristics matched in order of specificity. The exact string matches at the
// top come from errors we throw ourselves (the bridge throws "suiteql-timeout",
// the itemHeader query throws "item-not-found", the injected script throws
// "n-query-unavailable"). The fuzzy matches at the bottom absorb the
// free-form messages NetSuite returns from the REST endpoint.
export function mapSuiteQLError(err: unknown): FriendlyErrorCode {
  const message = err instanceof Error ? err.message : String(err);

  // Bridge timeout: thrown by content/bridge.ts when the postMessage round
  // trip exceeds the per-call timeout.
  if (message === "suiteql-timeout") return "timeout";
  // Injected script unavailable: thrown when the page-context script reports
  // it can't load N/query.
  if (message === "n-query-unavailable") return "n-query-unavailable";
  // Item lookup miss: thrown by runItemHeaderQuery when neither the primary
  // nor fallback query returned a row.
  if (message === "item-not-found") return "item-not-found";

  const lower = message.toLowerCase();

  // MLI-off detection: NetSuite's REST endpoint returns a message that
  // includes the inventoryitemlocations table name and the phrase "not found"
  // when the table is unavailable (MLI disabled or feature off in the account).
  if (lower.includes("inventoryitemlocations") && lower.includes("not found")) {
    return "inventory-not-enabled";
  }

  // Permission / role errors: NetSuite phrasing varies between "Insufficient
  // privilege", "Permission Violation", and references to the ROLE table when
  // a role lacks the SuiteQL permission. Match any of those signals.
  if (
    lower.includes("permission") ||
    lower.includes("role") ||
    lower.includes("insufficient privilege")
  ) {
    return "no-permission";
  }

  return "unknown";
}
