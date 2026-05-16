# Known issues

Tracked technical debt and limitations. Each entry has a severity tag
(blocker / major / minor).

## Bundle size (minor)

- The content script bundle hovers around 255 kB. Cause: React 18 +
  Zod + every query module loaded eagerly.
- Polish target: 150 kB content, 100 kB popup. Resolving this needs
  tree-shake / lazy-load work on the query modules.

## SuiteQL bridge does not propagate AbortSignal (major)

- `query-budget.ts` produces an `AbortController` that stops
  client-side handling, but the bridge in
  [src/content/bridge.ts](../src/content/bridge.ts) does not forward
  the signal to the page-context script. In-flight SuiteQL keeps
  running on the NetSuite side until its own timeout (set per call
  via `runSuiteQL(..., { timeoutMs })`).
- Symptom: the popup ignores late resolutions (via a `cancelled`
  flag), but the user's network tab will show requests completing
  after the popup is closed.
- Resolution path: the bridge can post an `abort` message that the
  injected script catches and uses to cancel its
  `query.runSuiteQL` promise.

## Synthetic SuiteQL fixtures (minor)

- All fixtures in `tests/fixtures/suiteql/` were authored from
  documented SuiteQL semantics, **not** extracted from real
  production accounts. Real-account behavior may surface schema
  variations (column casing, extra columns, null shapes).
- Mitigation: the runtime schema probe inspects actual account
  schemas and adapts queries.

## HoverPopup data-display has no full render tests (minor)

- The popup's data layer (cache, queries, error mapping, badge,
  line-quantity, tab visibility) is covered by unit tests. The full
  data-display rendering (header + locations table + next-receipt
  section + tabs with stubbed cache data) is exercised only via the
  Playwright E2E against a mocked NetSuite list page.

## Locations table cap at 8 rows + "+N more" (minor)

- Accounts with > 8 locations show only the first 8 in the popup.
  Users must follow the "View full record" link to see the rest.
  Trade-off for popup height.

## L2 cache eviction uses O(N) `chrome.storage.local.get(null)` scan (minor)

- `PersistentCache` scans every key on every write to detect overflow
  past the L2 maximum (500 entries). With hover-paced writes (one per
  successful query, ~5 per popup open), this is bounded but not free.
- Watch the scan cost when prefetch (10–25 writes at once) is active.
  If it becomes visible, switch to an index-key pattern.

## Quota errors on L2 write are silently logged (minor)

- `PersistentCache.write` swallows `chrome.storage.local` quota errors
  to keep L1 functional. The user has no indication the persistent
  layer is full.
- Polish target: an options-page warning if quota usage exceeds 80%
  of the budget.

## Mid-flight line-quantity edits do not refresh the badge (minor)

- The popup's `lineQty` is captured once via `useMemo` on mount. If
  the user edits the row's quantity input while the popup is open,
  the badge color goes stale until the popup closes and re-opens.
- No fix planned: the popup is a hover overlay, not a live monitor.
