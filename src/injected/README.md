# Page-context injected scripts

This folder holds scripts that run in the **page's main world** rather
than the content-script isolated world. They exist so the extension
can call NetSuite's already-loaded AMD modules — primarily `N/query`
for SuiteQL execution.

## What this is

Content scripts injected by a Manifest V3 extension run in an isolated
JavaScript world. They share the DOM with the host page but **not**
its `window` globals, AMD `require`, or module registry. That means a
content script cannot call `N/query.runSuiteQL` directly: from its
perspective `require` and the NetSuite module cache do not exist.

Page-context scripts solve this by running in the same world as the
host page. NetSuite's AMD loader has already registered `N/query` (and
the rest of `N/*`) by the time we inject. A page-context script can
therefore `require(["N/query"], ...)`, run a SuiteQL query against the
user's existing session, and post the result back to the content
script via `window.postMessage`.

The trade-off: page-context scripts cannot use the `chrome.*` APIs,
cannot read extension storage, and cannot import other extension
modules at runtime. They are intentionally small — request in, result
out, no business logic.

## How injection works

The content-side bridge ([src/content/bridge.ts](../content/bridge.ts))
performs lazy injection on the first SuiteQL call:

```ts
const el = document.createElement("script");
el.src = browser.runtime.getURL("/injected.js");
el.onload = () => el.remove();
(document.head ?? document.documentElement).appendChild(el);
```

WXT 0.20 emits unlisted scripts at the top of the build output, so the
file at [src/entrypoints/injected.ts](../entrypoints/injected.ts) lands
as `/injected.js` in the packaged extension and in the
`web_accessible_resources` manifest entry.

The browser sees a `<script src="chrome-extension://...">` tag and
places the resulting execution in the page's main world. The tag is
removed after `load` to keep the DOM clean. The handshake message
(see below) confirms the injected script is actually live before the
bridge sends any requests; subsequent calls reuse the same loaded
script.

## postMessage protocol

All messages flow via `window.postMessage(payload, window.location.origin)`.
Both sides validate `event.source === window` and
`event.origin === window.location.origin` before reading the payload.

### Content -> Injected (request)

```ts
{
  source: "nsl-content",
  id: string,                              // UUID, used for correlation
  type: "suiteql",
  query: string,                           // SQL string from src/lib/queries/
  params: ReadonlyArray<string | number>   // positional ? substitutions
}
```

### Injected -> Content (ready handshake)

Posted exactly once when the script loads:

```ts
{
  source: "nsl-injected",
  type: "ready"
}
```

### Injected -> Content (result)

Success:

```ts
{
  source: "nsl-injected",
  id: string,                              // echoes the request id
  type: "result",
  ok: true,
  rows: Array<Record<string, unknown>>
}
```

Failure:

```ts
{
  source: "nsl-injected",
  id: string,
  type: "result",
  ok: false,
  error: string
}
```

## Correlation & timeout

The bridge maintains a `Map<id, { resolve, reject, timer }>`. On every
outbound request it starts a 3000 ms timer; if the timer fires before
a matching `result` message arrives, the bridge calls `reject(new Error("suiteql-timeout"))`,
deletes the entry, and any subsequent late reply is ignored. On
success, `clearTimeout(timer)` runs before `resolve(rows)`.

## Error modes

- **`n-query-unavailable`** — `require(["N/query"], ...)` fails because
  the AMD registry has not loaded the module (rare; happens on pages
  where NetSuite has not initialised, e.g. blank dashboards). The
  injected script surfaces this error code verbatim; callers should
  treat the surface as unsupported and skip popup mount.
- **SuiteQL syntax / permission errors** — surfaced verbatim from the
  rejection of `query.runSuiteQL`. The bridge wraps the string in an
  `Error` so React renders the user-facing message defined in the
  query wrapper, not the raw text.
- **Timeout** — the content side gives up after 3000 ms. The injected
  script does not know the request was abandoned; any later reply is
  dropped on arrival.

## Why this approach

- **Zero configuration.** No Integration Record, no client ID, no
  OAuth screen. The user installs the extension and it works in every
  NetSuite account they are already logged into.
- **Session reuse.** Queries run with the user's current role and
  permissions, so the extension never exposes data the user could not
  see manually.
- **No remote secrets.** Nothing to embed in the bundle, nothing to
  rotate.

Compared to the alternatives: scraping REST headers from the page and
replaying them in `fetch` is fragile (headers expire, some are
hidden), and running a full OAuth flow forces every user through an
Integration Record setup for v1 — too much friction.

## Future fallback

If NetSuite changes the AMD loader, restricts page-context script
injection via a stricter CSP, or moves SuiteQL to a different module,
this path breaks. The planned fallback is an OAuth 2.0 + PKCE flow
against `/services/rest/query/v1/suiteql`. The injected-script approach
can stay as the preferred zero-config option when it works, with OAuth
as fallback per account.

## Security note

The injected script does exactly one thing: it reads the result rows
from `N/query.runSuiteQL` and posts them via
`window.postMessage(payload, window.location.origin)`. It does not
accept external commands, does not expose credentials, and does not
read cookies or storage directly. The user's session cookies travel
with the SuiteQL call automatically because the request originates
from the same origin.

The content-side bridge validates **every** incoming message before
acting on it:

- `event.source === window` (message came from this tab)
- `event.origin === window.location.origin` (same origin, not a frame
  from elsewhere)
- `event.data.source === "nsl-injected"` (our own envelope)

Anything failing those checks is dropped silently.
