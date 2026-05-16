# NetSuite Stock Lens

Chrome extension (Manifest V3) that shows live NetSuite inventory data
on hover when working inside NetSuite transactions. Open source under
the MIT License; distributed free via the Chrome Web Store.

## What it does

Hovering an item in a NetSuite transaction (Sales Order, Quote,
Invoice, Item Fulfillment, Purchase Order, Vendor Bill, Transfer Order)
opens a popup with:

- Inventory totals: on hand, committed, available, on order.
- Location breakdown when the account has Multi-Location Inventory.
- Next incoming PO with expected date.
- Red / yellow / green badge based on availability vs. demand.
- Optional tab with recent sales, average daily demand and estimated
  days of stock.
- Detection in list views and saved searches with smart prefetch.

All data is fetched by reusing the user's active NetSuite session —
the extension does not require Integration Records or OAuth setup.

## Why it exists

NetSuite already ships QuickView and the Item 360 Dashboard, but:

- QuickView does not display quantities when Multi-Location Inventory
  is on (Enhancement #229306, open since 2019).
- Item 360 lives on a separate page: the user has to leave the
  transaction to consult it.

Stock Lens delivers that context inline, without pulling the user out
of their workflow.

## Stack

- [WXT](https://wxt.dev/) (extension framework, Vite + native MV3)
- TypeScript strict
- React 18 (popup, options, hover overlay)
- Tailwind CSS (popup + options) + CSS inside a Shadow DOM (overlay)
- Zod (validation) + a custom LRU + `chrome.storage.local` cache for
  in-flight dedup and stale-while-revalidate
- Vitest (unit), Playwright (E2E)
- Biome (lint + format)
- pnpm

Architecture details, threat model and authentication strategy live in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Layout

```
src/
  content/       Content scripts (run inside NetSuite tabs)
  entrypoints/   WXT-declared entrypoints (popup, options, content, background, injected)
  injected/      Page-context scripts (access to N/query and N/*)
  lib/           Shared utilities
    queries/     One file per SuiteQL query
  types/         Shared TypeScript types

docs/            Architecture and known issues
tests/           Vitest unit + Playwright E2E
```

## Requirements

- Node 20+
- pnpm
- Recent Chrome / Chromium for `pnpm dev`
- At least one NetSuite test account with an active session to verify
  the authentication roundtrip

## Commands

```sh
pnpm install        # install deps and run wxt prepare (postinstall)
pnpm dev            # WXT dev mode with auto-reload
pnpm build          # production build
pnpm zip            # package the .zip for Chrome Web Store
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run
pnpm test:watch     # vitest watch
pnpm test:e2e       # playwright test
pnpm lint           # biome check --write .
pnpm lint:check     # biome check (no writes)
```

## Loading the local build in Chrome

1. `pnpm build`
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and pick `.output/chrome-mv3/`.
4. Open any NetSuite tab and hover over an item.

The default trigger is **hover with delay**. It can be switched to
shift-hover or long-press from the options page.

## Status

v1.0.0 is published on the Chrome Web Store. The extension covers Sales
Order, Quote, Invoice, Item Fulfillment, Purchase Order, Vendor Bill
and Transfer Order surfaces, plus list views and saved searches.

## Contributing

Bug reports, feature requests and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding
conventions and the PR process.

## Privacy

- All NetSuite data stays **only** on the user's machine (in-memory
  cache + `chrome.storage.local`).
- The extension does not send data to remote servers.
- `host_permissions` is restricted to `*.netsuite.com`,
  `*.app.netsuite.com` and `*.suiteapp.com`.
- No analytics or telemetry. Any future addition must be explicit
  opt-in.

## License

[MIT](LICENSE) © 2026 Fabian Rodriguez. The bundle published on the
Chrome Web Store is minified and shipped without source maps; the
source files in this repository are the canonical reference.
