/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */

// Page-context script. Runs inside the NetSuite document's JS realm and uses
// the AMD `require` to access N/query. See `src/injected/README.md` for the
// full message protocol.
//
// WXT detects this as an `unlisted-script` entrypoint via the
// `defineUnlistedScript` wrapper and the file's location directly under
// `src/entrypoints/`. The build emits it as `/injected.js`, which we list in
// `web_accessible_resources` so the content script can inject it via a
// `<script src="chrome-extension://.../injected.js">` tag.
//
// Currently only the SuiteQL bridge logic lives here. Future page-context
// modules can branch on the request envelope's `type` field.

type AmdRequire = (modules: string[], callback: (...mods: unknown[]) => void) => void;

interface NsQueryModule {
  runSuiteQL: {
    promise: (options: {
      query: string;
      params?: ReadonlyArray<string | number>;
    }) => Promise<NsResultSet>;
  };
}

interface NsResultSet {
  asMappedResults: () => Array<Record<string, unknown>>;
}

interface ContentMessage {
  source: "nsl-content";
  id: string;
  type: "suiteql";
  query: string;
  params?: ReadonlyArray<string | number>;
}

export default defineUnlistedScript(() => {
  function isContentMessage(data: unknown): data is ContentMessage {
    if (!data || typeof data !== "object") return false;
    const obj = data as { source?: unknown; type?: unknown };
    return obj.source === "nsl-content" && obj.type === "suiteql";
  }

  function post(message: unknown): void {
    window.postMessage(message, window.location.origin);
  }

  function loadQuery(): Promise<NsQueryModule> {
    return new Promise((resolve, reject) => {
      // biome-ignore lint/suspicious/noExplicitAny: AMD require is host-injected, untyped
      const req = (window as any).require as AmdRequire | undefined;
      if (typeof req !== "function") {
        reject(new Error("n-query-unavailable"));
        return;
      }
      try {
        req(["N/query"], (mod: unknown) => {
          if (!mod) {
            reject(new Error("n-query-unavailable"));
            return;
          }
          resolve(mod as NsQueryModule);
        });
      } catch {
        reject(new Error("n-query-unavailable"));
      }
    });
  }

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) return;
    if (!isContentMessage(event.data)) return;
    const { id, query, params = [] } = event.data;

    void (async () => {
      try {
        const queryMod = await loadQuery();
        const rs = await queryMod.runSuiteQL.promise({ query, params });
        const rows = rs.asMappedResults();
        post({
          source: "nsl-injected",
          id,
          type: "result",
          ok: true,
          rows,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        post({
          source: "nsl-injected",
          id,
          type: "result",
          ok: false,
          error: message,
        });
      }
    })();
  });

  post({ source: "nsl-injected", type: "ready" });
});
