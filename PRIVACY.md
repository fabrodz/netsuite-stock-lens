# Privacy Policy: NetSuite Stock Lens

_Last updated: 2026-05-16_

NetSuite Stock Lens ("the extension") is an open-source Chrome extension
that displays NetSuite inventory data inside NetSuite transaction pages.
This document describes what the extension does and does not do with
your data.

## Summary

- The extension does **not** collect, transmit, or sell any personal data.
- The extension does **not** include analytics, advertising, or tracking SDKs.
- All NetSuite data stays inside your browser. Nothing is sent to a server
  operated by the developer or any third party.

## What the extension reads

When the active tab is a NetSuite page matching the extension's host
permissions, the extension reads:

- The page DOM, to detect item links and the line quantity adjacent to
  them.
- The current URL, to determine which NetSuite surface (Sales Order,
  Quote, Invoice, etc.) you are on.

When you hover an item link, the extension issues SuiteQL queries
through NetSuite's own `N/query` module. This reuses the authenticated
session you are already logged into. The queries return inventory
totals, location breakdowns, scheduled receipts, and (only if you
enable them) recent sales and demand averages.

## What the extension stores

All storage is local to your browser. No data leaves the extension.

| Storage area | Contents | Purpose |
|---|---|---|
| `chrome.storage.sync` | User preferences (enable flag, trigger mode, hover delay, opt-in toggles, prefetch settings) | Sync your settings across Chrome installs signed into the same Google account |
| `chrome.storage.local` | Inventory cache (per item, per account), schema probe results | Avoid re-querying NetSuite on every hover; speed up the popup |

The local cache is keyed per item per account, holds up to 500 entries,
expires after 60 seconds (with a stale-while-revalidate window up to
5 minutes), and is purged when Chrome clears extension storage.

You can clear all stored data at any time by removing the extension or
by clearing site data for the extension in `chrome://settings/cookies`.

## What the extension does NOT do

- Does not send NetSuite data to any remote server.
- Does not store credentials. The extension uses your existing NetSuite
  browser session via the page-context `N/query` bridge. It never sees
  passwords or OAuth tokens.
- Does not include analytics, telemetry, or crash reporting.
- Does not advertise.
- Does not modify NetSuite data. No inserts, updates, or deletes are
  issued; the extension only runs read-only SuiteQL `SELECT` statements.
- Does not run outside of NetSuite domains. The content script is
  restricted to `*.netsuite.com`, `*.app.netsuite.com`, and
  `*.suiteapp.com` via `host_permissions`.

## Permissions explained

- **`storage`**: read and write the preferences and cache described above.
- **`host_permissions` (`*.netsuite.com`, `*.app.netsuite.com`,
  `*.suiteapp.com`)**: required so the content script can run inside
  NetSuite pages and issue SuiteQL queries through the page-context
  bridge.
- **`web_accessible_resources` (`injected.js`)**: the small page-context
  script that calls `N/query` on your behalf. It runs only on NetSuite
  pages and only when the content script injects it.

## Contact

Questions, security reports, or data requests:

**contact.fabrodz@gmail.com**

If you uninstall the extension, all data stored by the extension is
removed by Chrome automatically.
