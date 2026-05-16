/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { runSuiteQL } from "@/content/bridge";
import { PROBE_BINS, PROBE_LOTS, PROBE_MLI } from "@/lib/queries/schemaProbeQueries";

// Schema probe.
//
// Goal: detect once per account which inventory features are actually in
// use so the popup can skip queries that we know will fail (e.g. skip the
// itemLocations call on an MLI-off account). The probe queries themselves
// are tiny (one-row reads with rownum <= 1) and live in
// `src/lib/queries/schemaProbeQueries.ts`. Results are cached for 30 days
// under a dedicated storage namespace.
//
// ## Storage namespacing
//
// We deliberately use a **separate** prefix from the existing
// `PersistentCache` namespace (`nsl.cache.v2.`). The persistent cache
// regularly prunes anything matching its prefix older than the L2 stale
// window (5 minutes), which would wipe schema probes the moment they
// hit the 5-minute mark. Putting probes under `nsl.schema.v1.${accountId}`
// keeps them outside the cache's bookkeeping entirely. The version
// suffix lets us bump the on-disk shape later without colliding with
// pre-upgrade data.

export const SCHEMA_PROBE_STORAGE_PREFIX = "nsl.schema.v1.";
export const SCHEMA_PROBE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// Per-probe timeout. The probe should be a sub-second round trip on most
// accounts; a slow account or transient network blip is treated as "feature
// not present" so the popup keeps working with a conservative default
// (skip nothing).
const SCHEMA_PROBE_PER_QUERY_TIMEOUT_MS = 1500;

export interface SchemaProbeResult {
  accountId: string;
  // Date.now() at the moment the probe completed (success or feature-off).
  probedAt: number;
  // Multi-Location Inventory: `inventoryitemlocations` exists and has at
  // least one row. False also covers "table missing" and timeouts so a
  // conservative default is "MLI off, skip locations".
  mliEnabled: boolean;
  // Bin tracking: any row in `bin`.
  binTracking: boolean;
  // Lots and serials: any row in `inventorynumber`.
  lotsAndSerials: boolean;
}

// Minimal subset of chrome.storage.LocalStorageArea we need. Defined here so
// tests can supply a mock without depending on `chrome.storage.local`.
// Mirrors the contract used by `persistent-cache.ts` so consumers can
// reuse the same stub.
export interface SchemaStorageLike {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

// Storage envelope we persist. The schema fields live alongside the
// `probedAt` timestamp so a single read returns everything the popup
// needs.
interface StoredProbeEnvelope {
  accountId: string;
  probedAt: number;
  mliEnabled: boolean;
  binTracking: boolean;
  lotsAndSerials: boolean;
}

function defaultStorage(): SchemaStorageLike | null {
  // Guard for tests that don't stub chrome.storage.local. Returning null
  // makes read/write a no-op so the probe still runs but isn't cached.
  if (typeof chrome !== "undefined" && chrome?.storage?.local) {
    return chrome.storage.local as unknown as SchemaStorageLike;
  }
  return null;
}

// Module-level overrides for tests. Production never sets these; tests use
// `__setSchemaProbeStorage` and `__setSchemaProbeNow` to inject deterministic
// dependencies. We intentionally avoid a singleton "configure once" pattern
// because every consumer goes through `getOrProbeSchema` which is stateless
// from the caller's point of view.
let overrideStorage: SchemaStorageLike | null = null;
let overrideNow: (() => number) | null = null;

export function __setSchemaProbeStorage(storage: SchemaStorageLike | null): void {
  overrideStorage = storage;
}

export function __setSchemaProbeNow(now: (() => number) | null): void {
  overrideNow = now;
}

function getStorage(): SchemaStorageLike | null {
  return overrideStorage ?? defaultStorage();
}

function now(): number {
  return overrideNow ? overrideNow() : Date.now();
}

function storageKey(accountId: string): string {
  return `${SCHEMA_PROBE_STORAGE_PREFIX}${accountId}`;
}

function coerceEnvelope(raw: unknown): StoredProbeEnvelope | null {
  // Defensive coercion: if the on-disk shape doesn't match (an older
  // version, hand-edited storage, etc.) we drop it so a fresh probe runs.
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Partial<StoredProbeEnvelope>;
  if (typeof obj.accountId !== "string") return null;
  if (typeof obj.probedAt !== "number") return null;
  if (typeof obj.mliEnabled !== "boolean") return null;
  if (typeof obj.binTracking !== "boolean") return null;
  if (typeof obj.lotsAndSerials !== "boolean") return null;
  return obj as StoredProbeEnvelope;
}

// Runs a single probe query and returns whether the table is present AND
// non-empty. Any error (timeout, permission denied, table not found,
// abort) collapses to `false`: we'd rather treat a feature as off than
// claim it's on and have the popup retry against a table it can't query.
async function runSingleProbe(query: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }
  try {
    const rows = await runSuiteQL(query, [], {
      timeoutMs: SCHEMA_PROBE_PER_QUERY_TIMEOUT_MS,
    });
    return rows.length > 0;
  } catch {
    // Intentional swallow: any failure means the feature isn't usable in
    // this account/role. We don't log here because the probe is a startup
    // path and the failure cases (table missing on MLI-off accounts) are
    // expected, not bugs.
    return false;
  }
}

// Reads a cached probe for `accountId`. Returns null if missing, expired,
// or malformed. Expired entries are NOT deleted — `runSchemaProbe` will
// overwrite them next time it runs.
export async function readSchemaProbe(accountId: string): Promise<SchemaProbeResult | null> {
  const storage = getStorage();
  if (!storage) return null;
  const key = storageKey(accountId);
  let raw: Record<string, unknown>;
  try {
    raw = await storage.get(key);
  } catch (err) {
    console.warn("[nsl] schemaProbe: storage.get failed", err);
    return null;
  }
  const envelope = coerceEnvelope(raw[key]);
  if (!envelope) return null;
  // Expired entries are treated as missing so callers re-probe. We don't
  // delete here because the next write will overwrite the slot.
  if (now() - envelope.probedAt >= SCHEMA_PROBE_TTL_MS) {
    return null;
  }
  return envelope;
}

// Runs all three probe queries in parallel and writes the result. Idempotent
// within the TTL — calling twice within the 30-day window simply refreshes
// the cached value. Errors from individual probes are treated as "feature
// not present" (see `runSingleProbe`); the overall function never throws
// for SuiteQL-level errors.
export async function runSchemaProbe(
  accountId: string,
  signal?: AbortSignal,
): Promise<SchemaProbeResult> {
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const [mliEnabled, binTracking, lotsAndSerials] = await Promise.all([
    runSingleProbe(PROBE_MLI, signal),
    runSingleProbe(PROBE_BINS, signal),
    runSingleProbe(PROBE_LOTS, signal),
  ]);
  const result: SchemaProbeResult = {
    accountId,
    probedAt: now(),
    mliEnabled,
    binTracking,
    lotsAndSerials,
  };
  const storage = getStorage();
  if (storage) {
    const envelope: StoredProbeEnvelope = result;
    try {
      await storage.set({ [storageKey(accountId)]: envelope });
    } catch (err) {
      // Storage errors here are non-fatal — the caller still receives the
      // freshly-probed result. The next call re-probes and re-tries the
      // write.
      console.warn("[nsl] schemaProbe: storage.set failed", err);
    }
  }
  return result;
}

// Returns a cached probe if one is fresh, otherwise runs a new probe and
// caches it. The common case (popup mount after first visit) is a cache
// hit and a synchronous-feeling resolve.
export async function getOrProbeSchema(accountId: string): Promise<SchemaProbeResult> {
  const cached = await readSchemaProbe(accountId);
  if (cached !== null) return cached;
  return runSchemaProbe(accountId);
}
