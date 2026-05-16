/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// A single SuiteQL row, returned by N/query's asMappedResults().
// Values are unknown until validated against a Zod schema.
export type SuiteQLRow = Record<string, unknown>;

// Sent from the content script into the page-context injected script.
export interface ContentToInjectedMessage {
  source: "nsl-content";
  id: string;
  type: "suiteql";
  query: string;
  params: ReadonlyArray<string | number>;
}

// Sent from the page-context injected script back into the content script.
export type InjectedToContentMessage =
  | { source: "nsl-injected"; type: "ready" }
  | {
      source: "nsl-injected";
      id: string;
      type: "result";
      ok: true;
      rows: SuiteQLRow[];
    }
  | {
      source: "nsl-injected";
      id: string;
      type: "result";
      ok: false;
      error: string;
    };
