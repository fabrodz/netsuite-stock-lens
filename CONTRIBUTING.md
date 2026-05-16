# Contributing to NetSuite Stock Lens

Thanks for considering a contribution. Bug reports, feature requests
and pull requests are all welcome.

## Getting started

```sh
git clone https://github.com/fabrodz/netsuite-stock-lens.git
cd netsuite-stock-lens
pnpm install
pnpm dev
```

Requirements:

- Node 20 or newer
- pnpm
- A recent Chromium-based browser
- A NetSuite account with an active session (only needed if you want to
  test against real data; unit tests run against synthetic fixtures)

## Common commands

| Command            | What it does                                  |
| ------------------ | --------------------------------------------- |
| `pnpm dev`         | WXT dev server with auto-reload               |
| `pnpm build`       | Production build into `.output/`              |
| `pnpm zip`         | Package the `.zip` for Chrome Web Store       |
| `pnpm typecheck`   | `wxt prepare && tsc --noEmit`                 |
| `pnpm test`        | Vitest unit suite (one run)                   |
| `pnpm test:watch`  | Vitest in watch mode                          |
| `pnpm test:e2e`    | Playwright E2E suite                          |
| `pnpm lint`        | Biome check with auto-fix                     |
| `pnpm lint:check`  | Biome check without writes (used in CI)       |

## Code conventions

- TypeScript strict. No `any` without an inline comment explaining why.
- Async/await over `.then()`.
- Named exports only for React components.
- File naming: kebab-case for utilities, PascalCase for components.
- Tests in `tests/`, mirroring the `src/` structure.
- Comments explain *why*, not *what*.
- SuiteQL strings live in `src/lib/queries/`, never inlined in
  components. Each query file exports the SQL string, a Zod schema for
  the response and a typed wrapper function.
- Round any displayed numbers (`Math.round`, `toFixed`, `toLocaleString`).
- Every new source file carries the MIT license header. Copy one from a
  sibling.

See [CLAUDE.md](CLAUDE.md) for the same conventions in checklist form
and the project's NetSuite-specific notes.

## Pull request process

1. Open an issue first for non-trivial changes so we can agree on the
   approach before code is written.
2. Branch from `main`. Keep the branch focused on one change.
3. Run `pnpm lint:check`, `pnpm typecheck` and `pnpm test` before
   pushing. CI runs all three.
4. Add tests for new behaviour. The repo's bias is high test coverage
   for query parsing, cache logic and DOM detection.
5. Describe the change in the PR body: what changed, why, and how to
   verify it manually inside NetSuite if relevant.

## Don't do

- Don't add ESLint or Prettier. Biome replaces both.
- Don't add a state-management library (Redux, Zustand, Jotai, etc.).
  React state plus the cache layer is enough.
- Don't add TanStack Query or a similar fetch library. The bridge plus
  the LRU/persistent caches already cover dedup, retries and
  stale-while-revalidate.
- Don't store NetSuite data on remote servers without explicit user
  opt-in.
- Don't add analytics or telemetry SDKs without an explicit opt-in
  path agreed upfront.
- Don't inline SuiteQL strings in components; use `src/lib/queries/`.

## Reporting security issues

Please **do not** file public GitHub issues for security problems.
Email `contact.fabrodz@gmail.com` with the details and a proof of
concept. You'll get an acknowledgement within a few business days.

## License

By contributing, you agree that your contributions will be licensed
under the [MIT License](LICENSE) that covers the rest of the project.
