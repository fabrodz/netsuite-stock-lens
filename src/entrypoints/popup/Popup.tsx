/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import { type Preferences, getPreferences } from "@/lib/preferences";
import { useCallback, useEffect, useMemo, useState } from "react";

// Mirrors the human-readable instructions to whatever trigger mode the user has
// active — the popup card was hard-coded to "Hold Shift" even after we moved
// the default to plain hover, which left new users confused.
function triggerHint(prefs: Preferences | null): string {
  if (prefs === null) {
    return "Hover an item link inside a NetSuite transaction to see live inventory.";
  }
  switch (prefs.triggerMode) {
    case "shift-hover":
      return "Hold Shift and hover an item link inside a NetSuite transaction to see live inventory.";
    case "long-press":
      return "Press and hold an item link inside a NetSuite transaction to see live inventory.";
    default:
      return `Hover an item link for ${prefs.hoverDelayMs} ms inside a NetSuite transaction to see live inventory.`;
  }
}

export function Popup(): JSX.Element {
  const [prefs, setPrefs] = useState<Preferences | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPreferences().then((p) => {
      if (!cancelled) setPrefs(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const version = useMemo(() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return "dev";
    }
  }, []);

  // openOptionsPage is the supported MV3 entry point — it respects the
  // user's options_ui preference (embedded vs. full tab) without us
  // having to compute the URL ourselves.
  const handleOpenOptions = useCallback(async () => {
    try {
      await chrome.runtime.openOptionsPage();
      window.close();
    } catch {
      const optionsUrl = chrome.runtime.getURL("/options.html");
      await chrome.tabs.create({ url: optionsUrl });
      window.close();
    }
  }, []);

  return (
    <div className="min-w-[280px] p-4 font-sans text-sm text-slate-900">
      <header className="mb-3">
        <h1 className="text-base font-semibold">NetSuite Stock Lens</h1>
        <p className="text-xs text-slate-500">Version {version}</p>
      </header>
      <button
        type="button"
        onClick={handleOpenOptions}
        className="w-full rounded bg-slate-900 px-3 py-2 text-white hover:bg-slate-700"
      >
        Open settings
      </button>
      <p className="mt-3 text-xs text-slate-500">{triggerHint(prefs)}</p>
    </div>
  );
}
