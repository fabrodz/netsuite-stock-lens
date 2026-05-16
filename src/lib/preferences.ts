/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { z } from "zod";

// Single storage key for the entire preferences object. Storing one blob
// (rather than one entry per field) keeps `chrome.storage.onChanged` events
// compact and side-steps partial-write races between concurrent setters.
export const PREFERENCES_STORAGE_KEY = "nsl.preferences";

export const PreferencesSchema = z.object({
  enabled: z.boolean(),
  triggerMode: z.enum(["shift-hover", "hover-delay", "long-press"]),
  hoverDelayMs: z.number().int().min(200).max(1000),
  // Cross-record toggles. All default off so existing users see no
  // change in popup density until they explicitly opt in. `coerceWithDefaults`
  // below backfills the defaults for users upgrading from an older install.
  showRecentSales: z.boolean(),
  showDemand: z.boolean(),
  // Smart prefetch. `prefetchEnabled` defaults off because list-view
  // surfaces can mean a lot of items and we don't want to silently warm
  // hundreds of cache entries on someone who never hovers anything. When
  // enabled, the content script fetches headers for up to `prefetchN`
  // first-visible items after 3 s of idle. Bounds: 1..25 (design cap),
  // default 10. Concurrency is fixed at 3 in code and not user-tunable so
  // we keep a predictable upper bound on parallel SuiteQL load.
  prefetchEnabled: z.boolean(),
  prefetchN: z.number().int().min(1).max(25),
});

export type Preferences = z.infer<typeof PreferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  enabled: true,
  // Plain hover with a short delay is the default so the popup appears
  // without keyboard input. Users who want to require Shift can switch
  // to "shift-hover" in the options page; the mode coexists fine with
  // NetSuite's native QuickView (different DOM, our popup is in a Shadow
  // Root with z-index 999999).
  triggerMode: "hover-delay",
  hoverDelayMs: 400,
  showRecentSales: false,
  showDemand: false,
  prefetchEnabled: false,
  prefetchN: 10,
};

// Coerce arbitrary stored data into a typed Preferences. Anything missing
// or invalid falls back to the defaults. We never throw: invalid storage
// shouldn't break the extension.
function coerceWithDefaults(raw: unknown): Preferences {
  if (raw === undefined || raw === null) {
    return { ...DEFAULT_PREFERENCES };
  }
  // Merge first so fields the user has never touched (e.g. after we add a
  // new pref in a later phase) still pick up the default value.
  const merged =
    typeof raw === "object" && !Array.isArray(raw)
      ? { ...DEFAULT_PREFERENCES, ...(raw as Record<string, unknown>) }
      : { ...DEFAULT_PREFERENCES };
  const parsed = PreferencesSchema.safeParse(merged);
  if (!parsed.success) {
    console.warn("[nsl] invalid preferences in storage, using defaults", parsed.error.flatten());
    return { ...DEFAULT_PREFERENCES };
  }
  return parsed.data;
}

export async function getPreferences(): Promise<Preferences> {
  const result = await chrome.storage.sync.get(PREFERENCES_STORAGE_KEY);
  return coerceWithDefaults(result[PREFERENCES_STORAGE_KEY]);
}

export async function setPreferences(patch: Partial<Preferences>): Promise<Preferences> {
  const current = await getPreferences();
  const merged: Preferences = { ...current, ...patch };
  // Validate the merged result so a bad patch (e.g. out-of-range delay)
  // fails loudly rather than corrupting storage.
  const validated = PreferencesSchema.parse(merged);
  await chrome.storage.sync.set({ [PREFERENCES_STORAGE_KEY]: validated });
  return validated;
}

export function onPreferencesChanged(
  listener: (next: Preferences, previous: Preferences) => void,
): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "sync") return;
    const change = changes[PREFERENCES_STORAGE_KEY];
    if (!change) return;
    // Coerce both ends so consumers always receive valid Preferences even
    // if storage was wiped externally or contained legacy data.
    const next = coerceWithDefaults(change.newValue);
    const previous = coerceWithDefaults(change.oldValue);
    listener(next, previous);
  };

  chrome.storage.onChanged.addListener(handler);
  return () => {
    chrome.storage.onChanged.removeListener(handler);
  };
}
