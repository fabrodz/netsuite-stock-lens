/**
 * NetSuite Stock Lens
 * Copyright (c) 2026 Fabian Rodriguez
 * Licensed under the MIT License. See LICENSE in the project root.
 */
import {
  DEFAULT_PREFERENCES,
  type Preferences,
  getPreferences,
  setPreferences,
} from "@/lib/preferences";
import { useCallback, useEffect, useState } from "react";

// Indicator visibility window after a successful save. Short so it doesn't
// pile up if the user drags the slider quickly.
const SAVED_INDICATOR_MS = 1500;

export function Options(): JSX.Element {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [version, setVersion] = useState<string>("dev");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const initial = await getPreferences();
      if (!cancelled) {
        setPrefs(initial);
      }
    })();
    try {
      setVersion(browser.runtime.getManifest().version);
    } catch {
      // Manifest not available outside the extension context (tests, etc.).
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-hide the "Saved" indicator after the configured window.
  useEffect(() => {
    if (savedAt === null) return undefined;
    const timer = window.setTimeout(() => setSavedAt(null), SAVED_INDICATOR_MS);
    return () => window.clearTimeout(timer);
  }, [savedAt]);

  const persist = useCallback(async (patch: Partial<Preferences>) => {
    const next = await setPreferences(patch);
    setPrefs(next);
    setSavedAt(Date.now());
  }, []);

  if (prefs === null) {
    return <OptionsSkeleton />;
  }

  return (
    <main className="mx-auto max-w-2xl p-8 font-sans text-sm text-slate-900">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold">NetSuite Stock Lens: Options</h1>
        <SavedIndicator visible={savedAt !== null} />
      </header>

      <MasterSwitchSection enabled={prefs.enabled} onChange={(enabled) => persist({ enabled })} />

      <TriggerSection
        triggerMode={prefs.triggerMode}
        hoverDelayMs={prefs.hoverDelayMs}
        onTriggerModeChange={(triggerMode) => persist({ triggerMode })}
        onHoverDelayChange={(hoverDelayMs) => persist({ hoverDelayMs })}
      />

      <CrossRecordSection
        showRecentSales={prefs.showRecentSales}
        showDemand={prefs.showDemand}
        onShowRecentSalesChange={(showRecentSales) => persist({ showRecentSales })}
        onShowDemandChange={(showDemand) => persist({ showDemand })}
      />

      <PrefetchSection
        prefetchEnabled={prefs.prefetchEnabled}
        prefetchN={prefs.prefetchN}
        onPrefetchEnabledChange={(prefetchEnabled) => persist({ prefetchEnabled })}
        onPrefetchNChange={(prefetchN) => persist({ prefetchN })}
      />

      <AboutSection version={version} />
    </main>
  );
}

function OptionsSkeleton(): JSX.Element {
  return (
    <main className="mx-auto max-w-2xl p-8 font-sans text-sm text-slate-900">
      <div className="mb-6 h-7 w-72 animate-pulse rounded bg-slate-200" />
      <div className="mb-4 h-24 w-full animate-pulse rounded bg-slate-100" />
      <div className="mb-4 h-40 w-full animate-pulse rounded bg-slate-100" />
      <div className="h-32 w-full animate-pulse rounded bg-slate-100" />
    </main>
  );
}

interface SavedIndicatorProps {
  visible: boolean;
}

function SavedIndicator({ visible }: SavedIndicatorProps): JSX.Element {
  return (
    <span
      aria-live="polite"
      className={`text-xs font-medium text-emerald-600 transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      Saved
    </span>
  );
}

interface MasterSwitchSectionProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

function MasterSwitchSection({ enabled, onChange }: MasterSwitchSectionProps): JSX.Element {
  return (
    <section className="mb-6 rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="mb-3 text-base font-semibold">Master switch</h2>
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
        />
        <span>Enable extension on NetSuite pages</span>
      </label>
    </section>
  );
}

interface TriggerSectionProps {
  triggerMode: Preferences["triggerMode"];
  hoverDelayMs: number;
  onTriggerModeChange: (mode: Preferences["triggerMode"]) => void;
  onHoverDelayChange: (ms: number) => void;
}

function TriggerSection({
  triggerMode,
  hoverDelayMs,
  onTriggerModeChange,
  onHoverDelayChange,
}: TriggerSectionProps): JSX.Element {
  return (
    <section className="mb-6 rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="mb-3 text-base font-semibold">Trigger</h2>
      <fieldset className="space-y-3">
        <legend className="sr-only">Trigger mode</legend>

        <RadioRow
          name="triggerMode"
          value="shift-hover"
          checked={triggerMode === "shift-hover"}
          onChange={() => onTriggerModeChange("shift-hover")}
          label="Hold Shift and hover"
        />

        <div>
          <RadioRow
            name="triggerMode"
            value="hover-delay"
            checked={triggerMode === "hover-delay"}
            onChange={() => onTriggerModeChange("hover-delay")}
            label="Hover and wait (default)"
          />
          {triggerMode === "hover-delay" ? (
            <div className="mt-3 ml-7 flex items-center gap-3">
              <input
                type="range"
                min={200}
                max={1000}
                step={50}
                value={hoverDelayMs}
                onChange={(e) => onHoverDelayChange(Number(e.target.value))}
                className="flex-1"
                aria-label="Hover delay in milliseconds"
              />
              <span className="w-16 text-right tabular-nums text-slate-600">{hoverDelayMs} ms</span>
            </div>
          ) : null}
        </div>

        <div>
          <RadioRow
            name="triggerMode"
            value="long-press"
            checked={triggerMode === "long-press"}
            onChange={() => onTriggerModeChange("long-press")}
            label="Long press (mouse hold)"
          />
          {triggerMode === "long-press" ? (
            <p className="mt-2 ml-7 text-xs text-slate-500">Hold the mouse button for 500 ms</p>
          ) : null}
        </div>
      </fieldset>
    </section>
  );
}

interface RadioRowProps {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  label: string;
}

function RadioRow({ name, value, checked, onChange, label }: RadioRowProps): JSX.Element {
  return (
    <label className="flex cursor-pointer items-center gap-3">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 border-slate-300 text-slate-900 focus:ring-slate-500"
      />
      <span>{label}</span>
    </label>
  );
}

interface CrossRecordSectionProps {
  showRecentSales: boolean;
  showDemand: boolean;
  onShowRecentSalesChange: (value: boolean) => void;
  onShowDemandChange: (value: boolean) => void;
}

// Opt-in toggles for cross-record data. The popup auto-shows the
// tabbed footer when both data toggles are on, so no third switch is needed.
function CrossRecordSection({
  showRecentSales,
  showDemand,
  onShowRecentSalesChange,
  onShowDemandChange,
}: CrossRecordSectionProps): JSX.Element {
  return (
    <section className="mb-6 rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="mb-3 text-base font-semibold">Cross-record context</h2>
      <div className="space-y-3">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={showRecentSales}
            onChange={(e) => onShowRecentSalesChange(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
          />
          <span>Show recent sales (last 5)</span>
        </label>
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={showDemand}
            onChange={(e) => onShowDemandChange(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
          />
          <span>Show demand (30-day average + days of stock)</span>
        </label>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        These features add additional SuiteQL queries per hover. Turn off if popup latency becomes
        noticeable.
      </p>
    </section>
  );
}

interface AboutSectionProps {
  version: string;
}

function AboutSection({ version }: AboutSectionProps): JSX.Element {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="mb-3 text-base font-semibold">About</h2>
      <dl className="mb-3 text-xs text-slate-600">
        <div className="flex gap-2">
          <dt className="font-medium">Version</dt>
          <dd>{version}</dd>
        </div>
      </dl>
      <p className="text-xs text-slate-600">
        NetSuite Stock Lens is open-source software (MIT) distributed free through the Chrome Web
        Store. The compiled bundle is minified and does not include source maps. No NetSuite data
        leaves your browser. Caching is local only.
      </p>
    </section>
  );
}

interface PrefetchSectionProps {
  prefetchEnabled: boolean;
  prefetchN: number;
  onPrefetchEnabledChange: (value: boolean) => void;
  onPrefetchNChange: (value: number) => void;
}

// Smart prefetch options.
//
// We only surface the slider when the toggle is on — when prefetch is
// disabled the number has no effect, and showing a disabled slider
// implies it's the only blocker (which is misleading when there's also
// the "list-view surface" requirement).
function PrefetchSection({
  prefetchEnabled,
  prefetchN,
  onPrefetchEnabledChange,
  onPrefetchNChange,
}: PrefetchSectionProps): JSX.Element {
  return (
    <section className="mb-6 rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="mb-3 text-base font-semibold">Smart prefetch</h2>
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={prefetchEnabled}
          onChange={(e) => onPrefetchEnabledChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
        />
        <span>Prefetch inventory in list views</span>
      </label>
      {prefetchEnabled ? (
        <div className="mt-3 ml-7 flex items-center gap-3">
          <input
            type="range"
            min={1}
            max={25}
            step={1}
            value={prefetchN}
            onChange={(e) => onPrefetchNChange(Number(e.target.value))}
            className="flex-1"
            aria-label="Number of items to prefetch"
          />
          <span className="w-16 text-right tabular-nums text-slate-600">{prefetchN} items</span>
        </div>
      ) : null}
      <p className="mt-3 text-xs text-slate-500">
        Prefetches up to N items after 3 s of idle in list views. Concurrency capped at 3.
      </p>
    </section>
  );
}
