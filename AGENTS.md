# NetSuite Stock Lens

Conventions and project context for AI coding agents (Claude Code,
OpenAI Codex CLI, Aider, Cursor, etc.) and for human contributors.

## What this is

Chrome extension (Manifest V3) that shows live NetSuite inventory data
on hover when working inside NetSuite transactions. Open source under
the MIT License; distributed free via the Chrome Web Store.

Architecture and design decisions live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Tech stack

- WXT (Vite-based extension framework)
- TypeScript strict
- React 18 (popup, options, hover overlay)
- Tailwind CSS (popup, options) + Shadow DOM CSS-in-JS (content overlay)
- Zod (validation)
- Custom in-memory LRU + `chrome.storage.local` persistent cache (no
  TanStack Query, no Redux/Zustand: React state plus the cache layer
  in `src/lib/cache.ts` and `src/lib/persistent-cache.ts` cover the
  needs)
- Vitest (unit), Playwright (E2E)
- Biome (lint + format)
- pnpm

## NetSuite-specific knowledge

- Authentication: page-context script injection that uses the
  already-loaded `N/query` module (zero-config, reuses user session).
  See [src/injected/README.md](src/injected/README.md).
- Manifest V3, `host_permissions` limited to `*.netsuite.com`,
  `*.app.netsuite.com`, `*.suiteapp.com`.
- Target NetSuite versions: 2024.1 through current. Test in both
  Classic and Redwood UI.

## Folder structure

- `src/content/`        Content scripts (run in NetSuite tabs)
- `src/injected/`       Page-context scripts (have access to `N/*` modules)
- `src/entrypoints/`    WXT-declared entrypoints (popup, options, content, background)
- `src/lib/`            Shared utilities (cache, SuiteQL client, queries)
- `src/lib/queries/`    One file per logical SuiteQL query
- `src/types/`          Shared TypeScript types
- `docs/`               Architecture, known issues
- `tests/`              Vitest unit + Playwright E2E

## Conventions

- TypeScript strict, no `any` without an inline comment explaining why.
- Async/await over `.then()`.
- Named exports only for components.
- File naming: kebab-case for utilities, PascalCase for components.
- Tests live in `tests/`, mirroring `src/` structure.
- Comments explain *why*, not *what*.
- SuiteQL strings always in `src/lib/queries/`, never inlined in components.
- Each query file exports the SQL string, a Zod schema for the response,
  and a typed wrapper function.
- Round displayed numbers (`Math.round`, `toFixed`, `toLocaleString`).
- License header on each source file (MIT, see LICENSE).

## Common commands

- `pnpm install`     install deps + run `wxt prepare` (postinstall)
- `pnpm dev`         WXT dev mode, auto-reload
- `pnpm build`       production build
- `pnpm zip`         package the `.zip` for Chrome Web Store
- `pnpm typecheck`   `wxt prepare && tsc --noEmit`
- `pnpm test`        Vitest unit run
- `pnpm test:watch`  Vitest watch mode
- `pnpm test:e2e`    Playwright E2E
- `pnpm lint`        `biome check --write .`
- `pnpm lint:check`  `biome check .` (no writes)

## Privacy and data handling

- All NetSuite data stays only on the user's machine (in-memory cache
  plus `chrome.storage.local`).
- The extension does not send data to remote servers.
- No analytics or telemetry. Any future telemetry must be opt-in.
- The packaged bundle is publicly readable after install. No secrets
  in code.

## Don't do

- Don't add ESLint or Prettier (Biome replaces both).
- Don't add a state-management library (Redux, Zustand, Jotai, etc.).
  React state plus the cache layer is enough for the popup and options.
- Don't add TanStack Query or a similar fetch library. The bridge in
  `src/content/bridge.ts` plus the LRU/persistent caches already cover
  in-flight dedup, retries and stale-while-revalidate.
- Don't store NetSuite data on remote servers without explicit user opt-in.
- Don't add analytics or telemetry SDKs without an explicit opt-in path.
- Don't inline SuiteQL strings in components; use `src/lib/queries/`.
- Don't add AI co-author trailers (`Co-Authored-By: <AI tool>`) to commit
  messages. Commits should reflect the human author only.
