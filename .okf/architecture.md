---
type: Architecture
title: cmux-picker module design
description: Extension, native host, and CLI split between browser and Node; relay-based picker; screenshot captured by the service worker
tags: [extension, native-messaging, chrome, modules, architecture]
generated:
  by: claude/sonnet-5
  at: 2026-09-09
status: stable
sources:
  - resource: ../README.md
  - resource: ../UPSTREAM.md
  - resource: ../package.json
  - resource: ../vite.config.ts
  - resource: ../extension/manifest.json
  - resource: ../src/extension/picker.ts
  - resource: ../src/extension/dom.ts
  - resource: ../src/extension/agents.ts
  - resource: ../src/extension/crop.ts
  - resource: ../src/extension/content.ts
  - resource: ../src/extension/background.ts
  - resource: ../src/compose.ts
  - resource: ../src/types.ts
  - resource: ../src/cmux.ts
  - resource: ../src/validate.ts
  - resource: ../src/bridge.ts
  - resource: ../src/native.ts
  - resource: ../src/host.ts
  - resource: ../src/cli.ts
  - resource: ../src/host-name.ts
---

## System Decomposition

Four processes: the page (content script and picker, isolated world, top frame only), the service worker (Chrome's own process), the native host (a Node child process Chrome spawns), and cmux (a separate process behind its own Unix socket). Only the service worker talks to two neighbors, content script and native host; the native host talks to cmux and nothing else.

| File | Responsibility |
|---|---|
| **Browser: content script + picker (isolated world, top frame)** |
| `src/extension/picker.ts` | Shadow-DOM popup: outline and chip on hover, shift+click multi-select (up to 5 elements total), popup with To field, agent list, prompt textarea, in-flight status polling. Exports `mount(relay)`, the `Relay`/`RelayReply<T>` types, and `window.__cmux` (debug/e2e API). No hotkey listener: picking is armed by `window.__cmux.start()`, which toggles idle to picking. |
| `src/extension/dom.ts` | Pure DOM: `deepElementFromPoint` (shadow-aware hit test, excludes the picker's own overlay host), `sourceHint` (locator attributes, then Vue/React runtime introspection), `selectorPath` (up to 6 segments, crosses shadow boundaries with ` >>> `), `trimHtml`/`styleSummary`/`describeElement`, `popupPathLabel`, `spawnHint`, `truncateStart`, `stripHintSuffix`. No `parseHotkey`/`matchesHotkey`. |
| `src/extension/agents.ts` | Pure state: `groupAgents` (by workspace), `selectableIds`, `pickAgent` (preselection order: last used pane, then last used session, then an idle/done agent in the focused workspace, then any agent in it, then the focused agent, then the first selectable one), `devWorkspaceLabel`. |
| `src/extension/crop.ts` | Pure image: `cropRegion` (CSS-pixel rect plus margin to device pixels, width/height clamped 16..4000), `cropDataUrl` (decodes a data URL image, crops via canvas, returns base64 PNG without the `data:` prefix). |
| `src/extension/content.ts` | Content script: builds the `Relay` by messaging the service worker (`chrome.runtime.sendMessage`), mounts the picker once per page (`HOST_MARKER` dedupe), and listens for `{ type: 'pick' }` from the background with no sender check. |
| **Service worker (Chrome's process)** |
| `src/extension/background.ts` | `callHost(method, params)` lazily opens `chrome.runtime.connectNative(HOST_NAME)`, correlates replies by a `crypto.randomUUID()` id in a `pending` map, and disconnects after 60s idle. `onMessage` requires `sender.id === chrome.runtime.id`, then routes `{ type: 'capture' }` to `chrome.tabs.captureVisibleTab` and `{ type: 'host', method, params }` to `callHost`. `commands.onCommand('pick')` and `action.onClicked` inject `content.js` and send it `{ type: 'pick' }`. Exposes `__cmuxPick` for e2e. |
| **Native host (Node child process)** |
| `src/host.ts` | Entry point: resolves the socket path, runs `cleanupAttachments` once, decodes stdin frames in a loop, and dispatches each to the handler without waiting for it (`void handler(msg).then(reply => stdout.write(...))`), so replies can leave in a different order than requests arrived. Exits on stream end or a decode error. |
| `src/native.ts` | `decodeFrames`/`encodeFrame`: 4-byte little-endian length prefix plus UTF-8 JSON, capped at `MAX_FRAME_BYTES` (16 MiB) in and `MAX_REPLY_BYTES` (1 MiB) out. `focusedEnv` reads `focused_workspace_id`, `focused_pane_id`, and the focused pane's `cwd` out of a `session.snapshot` result. `createHandler` validates the envelope, then routes `state`/`prompt`/`spawn`, mapping a `CmuxError` through `httpStatus(code)` and anything else to 500. |
| `src/host-name.ts` | `HOST_NAME = 'com.scaccogatto.cmux_picker'`, shared by `cli.ts` (manifest) and `background.ts` (`connectNative`). |
| **Bridge and composition (shared with vite-plugin-cmux, runs on Node)** |
| `src/bridge.ts` | `getState` (`session.snapshot` to `StateResponse`; `screenshot` is hardcoded `'available'`), `toAgentRow`/`toWorkspaceRow`, `absolutizeHint`, `postPrompt` (`agent.prompt`; inlines the snippet or writes an attachment file past `inlineMaxChars`; writes an optional screenshot PNG, logging and continuing on failure), `spawnAgent` (`pane.split` or `worktree.create`, then `agent.start`), `writeAttachment`, `cleanupAttachments` (24h). No `watchAgent`. |
| `src/compose.ts` | Pure, shared with vite-plugin-cmux: `renderAttachment` (attachment markdown), `composePrompt` (the `[cmux-picker]` ASCII prompt). |
| `src/types.ts` | Shared shapes: `ElementInfo`, `Rect`/`Viewport`, `AgentRow`/`WorkspaceRow`/`AgentStatus`, `StateResponse` (a `cmux: true \| false` union), `PromptRequest`/`PromptResponse`, `SpawnRequest`/`SpawnResponse`, `ErrorResponse`. No `Relay` here; it lives in `picker.ts`. |
| `src/cmux.ts` | Socket client: `request()` opens one `net` connection per call, writes one NDJSON line, resolves on the first `\n`-terminated reply line, then ends the socket. `CmuxError { code }`, `httpStatus(code)`, `resolveSocketPath`. No `subscribe`. |
| `src/validate.ts` | `validateElement`, `validatePrompt` (prompt at most 20000 chars, at most 4 `extras`, optional `screenshotPng` at most 8,000,000 base64 characters matching a base64-charset regex), `validateSpawn` (`{ mode: 'here' \| 'worktree', name?, branch? }`). No frame-size caps here; those are `native.ts`'s. |
| **CLI and installer** |
| `src/cli.ts` | `extensionIdFromKey` (sha256 of the manifest's base64 `key`, first 16 bytes, each hex digit remapped `a`-`p`), `hostManifest`, `wrapperScript`, `browserDirs` (macOS and Linux only), `configDir`, `installHost`, `main(argv)`. Locates `host.js` and `extension/manifest.json` next to itself via `dirname(fileURLToPath(import.meta.url))`, and runs `main` only when `realpathSync(process.argv[1])` equals its own resolved path, so importing the module doesn't auto-run it. |

## Contracts

**Frame format** (`native.ts`): a 4-byte little-endian length prefix (the byte count of the payload, not including the prefix) followed by that many bytes of UTF-8 JSON. `decodeFrames` parses every complete frame at the front of a buffer and leaves an incomplete trailing frame in `rest`; a length over `maxBytes` throws. `encodeFrame` does the reverse.

**Envelope**, between the service worker and the native host, riding on the frames above:
- Request (background to host): `{ id: string, method: string, params: unknown }` (`background.ts`'s `callHost`; `id` is `crypto.randomUUID()`).
- Reply (host to background): `{ id, status: number, body?: unknown }` (`native.ts`'s `createHandler`; `id` echoes the request, `body` on error is `{ error: string, message: string }`).

**Relay interface**, exactly as written in `picker.ts`:

```typescript
/** How the picker reaches the native host, implemented by the content script */
export interface Relay {
  state(): Promise<StateResponse>
  prompt(body: PromptRequest): Promise<RelayReply<PromptResponse>>
  spawn(body: SpawnRequest): Promise<RelayReply<SpawnResponse>>
  /** Real pixels of the viewport rect (CSS px) plus a margin, as base64 PNG; rejects when capture is unavailable */
  capture(rect: Rect): Promise<string>
}

export interface RelayReply<T> { status: number; body: T | ErrorResponse }
```

**Host methods** (`native.ts`'s `createHandler`). Before dispatch: a non-object message or a non-string `id`/`method` is 400 `invalid_request`; an unrecognized method is 404 `not_found`.

| Method | Request validation | On invalid | 200 body |
|---|---|---|---|
| `state` | none; `params` is ignored | n/a | `StateResponse`: either the live `{ cmux: true, ... }` shape or `{ cmux: false, reason, message }`. The not-connected case rides inside the 200 body, not a different status; only a non-`CmuxError` throw becomes 500. |
| `prompt` | `validatePrompt(params)` | 400 `invalid_params` | `PromptResponse`: `{ ok: true, target, title, pane_id, screenshot }`. Errors from the `agent.prompt` call itself surface through `httpStatus()`: 409 (`agent_blocked`, `not_in_cmux`), 404 (`not_found`), 503 (`busy`), or 502 (anything else). |
| `spawn` | a best-effort `session.snapshot` for the focused pane's env, then `validateSpawn(params)` | 400 `invalid_params` | `SpawnResponse`: `{ ok: true, pane_id, name, workspace_id }`. `mode: 'here'` with no focused pane throws `CmuxError('not_in_cmux', ...)`, mapped to 409. |

`state` calls `session.snapshot` twice per request (once in the handler for the focused-pane env, once again inside `getState`); the code flags this itself with a `ponytail:` comment as a deliberate simplification, not an oversight.

`prompt` calls `postPrompt` with `roots: []` (`native.ts`), so `bridge.ts`'s `absolutizeHint` returns every source hint unchanged: relative hints from the page are never resolved against the agent's working directory. README's Limits section lists this under "Not yet."

**Service worker message types** (`background.ts`'s single `onMessage` listener, gated on `sender.id === chrome.runtime.id`, plus the one message it sends the other way):

| Direction | Message | Success | Failure |
|---|---|---|---|
| content to background | `{ type: 'capture' }` | the data URL string from `chrome.tabs.captureVisibleTab` | `{ error: 'capture_failed', message }` |
| content to background | `{ type: 'host', method, params }` | `{ status, body }` from the native host | `{ error: 'no_host' \| 'relay_failed', message }` (`classify()`: a message matching `/not found\|forbidden/i` is `no_host`, else `relay_failed`) |
| background to content | `{ type: 'pick' }` | `content.ts`'s listener calls `window.__cmux?.start()`; no sender check | n/a |

Error envelope, used by both capture and host failures: `{ error: 'no_host' | 'capture_failed' | 'relay_failed', message: string }`.

## Port Lifecycle

`connectNative(HOST_NAME)` is lazy: the first `callHost` call opens it. Requests are correlated by a `crypto.randomUUID()` id in a `pending` map; `onDisconnect` rejects everything still pending and clears the port. After every reply, an idle timer arms only if `pending.size === 0`; 60 seconds later, if still idle, the port disconnects and Chrome tears down the native host process (native messaging's own behavior). The next `callHost` call reconnects automatically, since `ensurePort` re-checks `port === null`. Because the host process exits with the port, the one-shot `cleanupAttachments` at `host.ts` startup effectively reruns on every reconnect after a gap in use, not just once per machine boot.

## Build Strategy

One `vite.config.ts`, two modes, run together by `npm run build` (`vite build && vite build --mode extension`):

- **Node build** (mode unset): entries `src/host.ts` and `src/cli.ts`, external only `/^node:/` (not `vite`: this package is not a Vite plugin), target `node20`, no minify. `dist/host.js` and `dist/cli.js` are self-contained: `package.json` has no `dependencies`, only `devDependencies`.
- **Extension build** (`mode: 'extension'`): `publicDir: 'extension'` copies `manifest.json` and `icons/` into `dist/extension/` as static files; entries `src/extension/content.ts` and `src/extension/background.ts` build to `dist/extension/content.js` and `background.js`, target `es2022`, no minify.

`allowImportingTsExtensions: true` (`tsconfig.json`) lets every `.ts` file import its siblings with a `.ts` extension; built output carries none. The manifest's `minimum_chrome_version` is `"117"`; `package.json`'s `engines.node` is `>=20`.

## Message Flow

1. `Ctrl+B` (or the toolbar icon) fires `commands.onCommand('pick')` or `action.onClicked` in the service worker.
2. `pickInTab` injects `content.js` and sends it `{ type: 'pick' }`.
3. `content.ts`'s `HOST_MARKER` check skips remounting if the picker is already on the page; either way, the mounted picker's `onMessage` listener calls `window.__cmux.start()`, which toggles: idle to picking, picking to idle.
4. On click, the picker calls `describeElement` (`dom.ts`) and opens the popup; `relay.state()` loads the agent list.
5. On send, the picker builds a `PromptRequest` from `typed.trim()`, the trusted-input copy, not `textarea.value`, and calls `relay.prompt(body)` (spawning first via `relay.spawn` when a `+ agent here`/`+ agent in worktree` row was chosen; that is a second request after the spawn succeeds).
6. `content.ts` forwards `{ type: 'host', method, params }`; `background.ts` relays it over the native port as `{ id, method, params }`.
7. `host.ts` decodes the frame, `native.ts`'s handler validates and dispatches, `bridge.ts` calls the cmux socket, the reply frame goes back.
8. The picker polls `relay.state()` every 2 seconds, up to 30 minutes, to drive the in-flight outline until the agent settles idle or done (green) or blocked (red).

## Copy Provenance

`src/extension/picker.ts`, `dom.ts`, `agents.ts`, plus `src/compose.ts`, `types.ts`, `cmux.ts`, `validate.ts`, `bridge.ts` (and the matching test helpers/specs) were copied from vite-plugin-cmux at commit `f5ef5e1` (`UPSTREAM.md` has the full file mapping, e.g. `validate.ts` was `http.ts`, `bridge.ts` was `server.ts`). The copies were then adapted for the extension in the merge commit `merge: adapt the copied core for the extension` (`UPSTREAM.md`). There is no runtime dependency between the two projects in either direction; fixes are ported by hand.
