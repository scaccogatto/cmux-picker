# cmux-picker

Chrome extension (Manifest V3) plus a native messaging host: pick a DOM element on any page and send it, with a prompt, to a coding agent running in cmux through the extension's service worker, the native host and cmux's Unix socket. Zero runtime dependencies. TypeScript strict. Tests with Vitest and Playwright end-to-end.

## Commands

- `npm run build`: Build the native host and the CLI (`dist/host.js`, `dist/cli.js`), then the unpacked extension (`dist/extension/`)
- `npm run typecheck`: Run TypeScript strict checks
- `npm run coverage`: Run tests with coverage
- `npm run lint`: Check code style with ESLint
- `npm run e2e`: Run Playwright end-to-end tests (loads the unpacked extension in Chromium)

## Development conventions

- **TypeScript imports**: All `.ts` files import from other `.ts` files with the `.ts` extension (e.g., `import { x } from './types.ts'`), enabled by `tsconfig.json` `allowImportingTsExtensions: true`. Built output ships bundled `.js` files.
- **Worktrees and commits**: For any task modifying code, use a git worktree (via EnterWorktree/ExitWorktree). Commit changes on your branch, then merge into main. Never commit generated `dist/` files.
- **e2e specs must never reach a real cmux**: the native host under test always runs with `CMUX_SOCKET_PATH` pointing at a fake cmux socket started from `src/__tests__/helpers/fake-cmux.ts` and `CMUX_PICKER_STATE_DIR` pointing at a temporary directory with fabricated hook session stores.
- **No dependency on vite-plugin-herdr or herdr-picker**: the shared modules were copied from vite-plugin-herdr (see `UPSTREAM.md`) and are owned here. Never import, link or depend on either package; port fixes by hand. Nothing is imported from cmux (GPL-3.0); we only speak its documented socket protocol.

## Open Knowledge Format (OKF)

This project keeps shared knowledge as an OKF bundle in `.okf/`.

- **Before a task**, if `.okf/` exists, read `.okf/index.md` first and follow links into the concepts relevant to the work. Weigh what you read: a `draft` or `deprecated` `status`, a `stale_after` already past, or no `verified` entry all mean "check before relying on this". Treat broken links as not-yet-written knowledge, not errors.
- **After a change** that affects a documented asset (service, API, schema, metric, runbook, decision), update the matching concept: refresh its body and `generated: { by, at }`, fix cross-links, and append a dated entry to the nearest `log.md`. Create a new concept for any new asset.
- **Capturing new knowledge** → use the `/okf:okf` skill (modes: produce, maintain, consume).
- **Before committing** bundle changes → run `/okf:validate .okf --strict` and resolve every error.

Conformance rule to respect: every concept file needs YAML frontmatter with a non-empty `type`. Everything else is optional. The bundle targets OKF v0.2.
