/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { PROBE_BINS, PROBE_LOTS, PROBE_MLI } from "@/lib/queries/schemaProbeQueries";
import {
  SCHEMA_PROBE_STORAGE_PREFIX,
  SCHEMA_PROBE_TTL_MS,
  type SchemaStorageLike,
  __setSchemaProbeNow,
  __setSchemaProbeStorage,
  getOrProbeSchema,
  readSchemaProbe,
  runSchemaProbe,
} from "@/lib/schemaProbe";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// `runSuiteQL` is called from inside the schema probe via the bridge
// module. We hoist-mock the bridge here so the probe never touches the
// real injected-script path during unit tests.
vi.mock("@/content/bridge", () => ({
  runSuiteQL: vi.fn(),
}));

// Pull the mocked runSuiteQL out of the bridge for per-test wiring. The
// import has to come after `vi.mock` for the mock to apply.
import { runSuiteQL } from "@/content/bridge";

const runSuiteQLMock = runSuiteQL as unknown as ReturnType<typeof vi.fn>;

// In-memory storage stub. Mirrors the contract of chrome.storage.local
// without the global side effects of the setup.ts stub (which only
// covers `chrome.storage.sync`).
function makeStorage(): { storage: SchemaStorageLike; data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  const storage: SchemaStorageLike = {
    async get(keys) {
      const out: Record<string, unknown> = {};
      if (keys === null || keys === undefined) {
        for (const [k, v] of data) out[k] = v;
      } else if (typeof keys === "string") {
        if (data.has(keys)) out[keys] = data.get(keys);
      } else if (Array.isArray(keys)) {
        for (const k of keys) if (data.has(k)) out[k] = data.get(k);
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    async remove(keys) {
      const ks = Array.isArray(keys) ? keys : [keys];
      for (const k of ks) data.delete(k);
    },
  };
  return { storage, data };
}

const ACCOUNT_ID = "TSTDRV1234567";
const PROBE_KEY = `${SCHEMA_PROBE_STORAGE_PREFIX}${ACCOUNT_ID}`;

beforeEach(() => {
  runSuiteQLMock.mockReset();
});

afterEach(() => {
  __setSchemaProbeStorage(null);
  __setSchemaProbeNow(null);
});

describe("runSchemaProbe", () => {
  test("returns all-true when every probe returns a row", async () => {
    const { storage } = makeStorage();
    __setSchemaProbeStorage(storage);
    __setSchemaProbeNow(() => 1_000_000);
    // Each probe call resolves with a single-row result.
    runSuiteQLMock.mockResolvedValue([{ present: 1 }]);

    const result = await runSchemaProbe(ACCOUNT_ID);
    expect(result).toEqual({
      accountId: ACCOUNT_ID,
      probedAt: 1_000_000,
      mliEnabled: true,
      binTracking: true,
      lotsAndSerials: true,
    });
    expect(runSuiteQLMock).toHaveBeenCalledTimes(3);
    // Each probe query is one of the three documented constants.
    const queries = runSuiteQLMock.mock.calls.map(([q]) => q);
    expect(queries.sort()).toEqual([PROBE_BINS, PROBE_LOTS, PROBE_MLI].sort());
  });

  test("treats query failure as feature-off (MLI fails -> mliEnabled false)", async () => {
    const { storage } = makeStorage();
    __setSchemaProbeStorage(storage);
    __setSchemaProbeNow(() => 2_000_000);
    // First call (MLI) rejects, the other two succeed. We don't rely on
    // call ordering since Promise.all may resolve in any order, but the
    // mock router below maps queries to outcomes.
    runSuiteQLMock.mockImplementation(async (query: string) => {
      if (query === PROBE_MLI) throw new Error("table not found");
      return [{ present: 1 }];
    });

    const result = await runSchemaProbe(ACCOUNT_ID);
    expect(result.mliEnabled).toBe(false);
    expect(result.binTracking).toBe(true);
    expect(result.lotsAndSerials).toBe(true);
  });

  test("treats empty result as feature-off", async () => {
    const { storage } = makeStorage();
    __setSchemaProbeStorage(storage);
    __setSchemaProbeNow(() => 3_000_000);
    runSuiteQLMock.mockImplementation(async (query: string) => {
      if (query === PROBE_BINS) return [];
      return [{ present: 1 }];
    });

    const result = await runSchemaProbe(ACCOUNT_ID);
    expect(result.binTracking).toBe(false);
    expect(result.mliEnabled).toBe(true);
    expect(result.lotsAndSerials).toBe(true);
  });

  test("persists the result to storage under the documented key", async () => {
    const { storage, data } = makeStorage();
    __setSchemaProbeStorage(storage);
    __setSchemaProbeNow(() => 4_000_000);
    runSuiteQLMock.mockResolvedValue([{ present: 1 }]);

    await runSchemaProbe(ACCOUNT_ID);
    expect(data.has(PROBE_KEY)).toBe(true);
    expect(data.get(PROBE_KEY)).toMatchObject({
      accountId: ACCOUNT_ID,
      probedAt: 4_000_000,
      mliEnabled: true,
    });
  });

  test("aborts before running when signal is already aborted", async () => {
    const { storage } = makeStorage();
    __setSchemaProbeStorage(storage);
    const controller = new AbortController();
    controller.abort();
    await expect(runSchemaProbe(ACCOUNT_ID, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(runSuiteQLMock).not.toHaveBeenCalled();
  });
});

describe("readSchemaProbe", () => {
  test("returns null when storage is empty", async () => {
    const { storage } = makeStorage();
    __setSchemaProbeStorage(storage);
    const result = await readSchemaProbe(ACCOUNT_ID);
    expect(result).toBeNull();
  });

  test("returns the cached probe when within TTL", async () => {
    const { storage, data } = makeStorage();
    __setSchemaProbeStorage(storage);
    __setSchemaProbeNow(() => 1_000_000);
    data.set(PROBE_KEY, {
      accountId: ACCOUNT_ID,
      probedAt: 999_000,
      mliEnabled: true,
      binTracking: false,
      lotsAndSerials: true,
    });
    const result = await readSchemaProbe(ACCOUNT_ID);
    expect(result).toEqual({
      accountId: ACCOUNT_ID,
      probedAt: 999_000,
      mliEnabled: true,
      binTracking: false,
      lotsAndSerials: true,
    });
  });

  test("returns null when the cached probe is expired", async () => {
    const { storage, data } = makeStorage();
    __setSchemaProbeStorage(storage);
    // probedAt was 0; now is past the TTL window.
    __setSchemaProbeNow(() => SCHEMA_PROBE_TTL_MS + 1);
    data.set(PROBE_KEY, {
      accountId: ACCOUNT_ID,
      probedAt: 0,
      mliEnabled: true,
      binTracking: true,
      lotsAndSerials: true,
    });
    const result = await readSchemaProbe(ACCOUNT_ID);
    expect(result).toBeNull();
  });

  test("returns null when stored shape is malformed (defensive coerce)", async () => {
    const { storage, data } = makeStorage();
    __setSchemaProbeStorage(storage);
    data.set(PROBE_KEY, { accountId: ACCOUNT_ID, probedAt: "yesterday" });
    const result = await readSchemaProbe(ACCOUNT_ID);
    expect(result).toBeNull();
  });
});

describe("getOrProbeSchema", () => {
  test("uses the cached probe when fresh and does not call SuiteQL", async () => {
    const { storage, data } = makeStorage();
    __setSchemaProbeStorage(storage);
    __setSchemaProbeNow(() => 1_000_000);
    data.set(PROBE_KEY, {
      accountId: ACCOUNT_ID,
      probedAt: 500_000,
      mliEnabled: false,
      binTracking: false,
      lotsAndSerials: false,
    });
    const result = await getOrProbeSchema(ACCOUNT_ID);
    expect(result.mliEnabled).toBe(false);
    expect(runSuiteQLMock).not.toHaveBeenCalled();
  });

  test("runs a fresh probe when the cache is expired", async () => {
    const { storage, data } = makeStorage();
    __setSchemaProbeStorage(storage);
    __setSchemaProbeNow(() => SCHEMA_PROBE_TTL_MS + 1_000_000);
    data.set(PROBE_KEY, {
      accountId: ACCOUNT_ID,
      probedAt: 0, // far in the past relative to mocked `now`
      mliEnabled: false,
      binTracking: false,
      lotsAndSerials: false,
    });
    runSuiteQLMock.mockResolvedValue([{ present: 1 }]);
    const result = await getOrProbeSchema(ACCOUNT_ID);
    expect(result.mliEnabled).toBe(true); // freshly probed
    expect(runSuiteQLMock).toHaveBeenCalledTimes(3);
  });
});
