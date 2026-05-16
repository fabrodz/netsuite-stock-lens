/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { vi } from "vitest";

// Minimal chrome.* stub for the popup, options, and content modules
// when imported in a jsdom environment. Tests that need richer behaviour
// should override these in their own beforeEach.
// In-memory backing store for the chrome.storage.sync stub. Tests that want
// a clean slate should reset it in their own beforeEach.
const syncStorage = new Map<string, unknown>();
// Registered listeners for chrome.storage.onChanged. We keep a single shared
// list so tests can verify add/remove behaviour via the spies below.
type StorageChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
) => void;
const storageChangeListeners = new Set<StorageChangeListener>();

const chromeStub = {
  runtime: {
    sendMessage: vi.fn(async () => undefined),
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onInstalled: {
      addListener: vi.fn(),
    },
    getURL: vi.fn((path: string) => `chrome-extension://test${path}`),
    getManifest: vi.fn(() => ({ version: "0.0.0" })),
  },
  tabs: {
    create: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => undefined),
    query: vi.fn(async () => []),
  },
  storage: {
    sync: {
      get: vi.fn(async (key?: string | string[] | null) => {
        const out: Record<string, unknown> = {};
        if (typeof key === "string") {
          if (syncStorage.has(key)) out[key] = syncStorage.get(key);
        } else if (Array.isArray(key)) {
          for (const k of key) {
            if (syncStorage.has(k)) out[k] = syncStorage.get(k);
          }
        } else {
          for (const [k, v] of syncStorage) out[k] = v;
        }
        return out;
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        const changes: Record<string, chrome.storage.StorageChange> = {};
        for (const [k, v] of Object.entries(items)) {
          changes[k] = { oldValue: syncStorage.get(k), newValue: v };
          syncStorage.set(k, v);
        }
        for (const listener of storageChangeListeners) {
          listener(changes, "sync");
        }
      }),
      remove: vi.fn(async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        const changes: Record<string, chrome.storage.StorageChange> = {};
        for (const k of keys) {
          if (syncStorage.has(k)) {
            changes[k] = { oldValue: syncStorage.get(k), newValue: undefined };
            syncStorage.delete(k);
          }
        }
        for (const listener of storageChangeListeners) {
          listener(changes, "sync");
        }
      }),
      clear: vi.fn(async () => {
        syncStorage.clear();
      }),
    },
    onChanged: {
      addListener: vi.fn((listener: StorageChangeListener) => {
        storageChangeListeners.add(listener);
      }),
      removeListener: vi.fn((listener: StorageChangeListener) => {
        storageChangeListeners.delete(listener);
      }),
    },
  },
};

// Test helpers: exported on the stub object so individual tests can reset
// the in-memory state without re-importing internals.
export function __resetChromeStorage(): void {
  syncStorage.clear();
  storageChangeListeners.clear();
}

export function __setChromeSyncValue(key: string, value: unknown): void {
  syncStorage.set(key, value);
}

export function __emitChromeStorageChange(
  changes: Record<string, chrome.storage.StorageChange>,
  areaName: string,
): void {
  for (const listener of storageChangeListeners) {
    listener(changes, areaName);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: test stub deliberately untyped
(globalThis as any).chrome = chromeStub;
// biome-ignore lint/suspicious/noExplicitAny: WXT's `browser` global aliases chrome.*
(globalThis as any).browser = chromeStub;
