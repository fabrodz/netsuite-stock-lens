/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import type {
  ContentToInjectedMessage,
  InjectedToContentMessage,
  SuiteQLRow,
} from "@/types/suiteql";

// Resolver registry for in-flight SuiteQL calls. Keyed by correlation id.
interface PendingCall {
  resolve: (rows: SuiteQLRow[]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingCall>();

// We only inject the page-context script once per page; subsequent calls reuse
// the same channel. `injected` is a module-level latch.
let injected = false;
let injectedReady = false;
const readyWaiters: Array<() => void> = [];

function isInjectedMessage(data: unknown): data is InjectedToContentMessage {
  if (!data || typeof data !== "object") return false;
  const obj = data as { source?: unknown };
  return obj.source === "nsl-injected";
}

function handleWindowMessage(event: MessageEvent): void {
  // Only trust same-origin messages — the injected script is on the same
  // origin as the NetSuite page itself.
  if (event.source !== window) return;
  if (!isInjectedMessage(event.data)) return;
  const msg = event.data;

  if (msg.type === "ready") {
    injectedReady = true;
    for (const waiter of readyWaiters.splice(0)) waiter();
    return;
  }

  const call = pending.get(msg.id);
  if (!call) return;
  clearTimeout(call.timer);
  pending.delete(msg.id);
  if (msg.ok) {
    call.resolve(msg.rows);
  } else {
    call.reject(new Error(msg.error));
  }
}

export function setupBridge(): void {
  if (injected) return;
  injected = true;
  window.addEventListener("message", handleWindowMessage);

  const script = document.createElement("script");
  // WXT emits the unlisted entrypoint at `src/entrypoints/injected/index.unlisted.ts`
  // as `/injected.js` in the build output (WXT supports at most one level of
  // entrypoint nesting and uses the folder name as the basename).
  script.src = browser.runtime.getURL("/injected.js");
  script.async = false;
  script.onload = () => {
    script.remove();
  };
  document.documentElement.appendChild(script);
}

function waitForReady(timeoutMs: number): Promise<void> {
  if (injectedReady) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("suiteql-injected-not-ready"));
    }, timeoutMs);
    readyWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export interface RunSuiteQLOptions {
  timeoutMs?: number;
}

export async function runSuiteQL(
  query: string,
  params: ReadonlyArray<string | number> = [],
  options: RunSuiteQLOptions = {},
): Promise<SuiteQLRow[]> {
  const timeoutMs = options.timeoutMs ?? 3000;
  setupBridge();
  await waitForReady(timeoutMs);

  const id = crypto.randomUUID();
  const message: ContentToInjectedMessage = {
    source: "nsl-content",
    id,
    type: "suiteql",
    query,
    params,
  };

  return new Promise<SuiteQLRow[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("suiteql-timeout"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    window.postMessage(message, window.location.origin);
  });
}
