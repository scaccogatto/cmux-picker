---
type: Policy
title: Security boundaries
description: Native messaging isolation, socket access control, page content as data, screenshot opt-in, trusted-event guards on an open shadow root
tags: [security, extension, native-messaging, cmux-socket, data-handling]
generated:
  by: claude/fable-5-1
  at: 2026-09-10
status: stable
sources:
  - resource: ../README.md
  - resource: ../extension/manifest.json
  - resource: ../src/extension/picker.ts
  - resource: ../src/extension/dom.ts
  - resource: ../src/extension/content.ts
  - resource: ../src/extension/background.ts
  - resource: ../src/extension/crop.ts
  - resource: ../src/validate.ts
  - resource: ../src/native.ts
  - resource: ../src/bridge.ts
  - resource: ../src/cli.ts
  - resource: ../src/host.ts
  - resource: ../src/host-name.ts
---

## Implemented Guards

**No localhost port, no token.** Chrome, not the page, spawns the native host over stdio; there is no socket for a page to reach. The only gate is the host manifest's `allowed_origins: ["chrome-extension://<id>/"]` (`cli.ts`'s `hostManifest`), which Chrome itself checks before it will pipe messages from the extension to the host.

**Socket access control is a real part of the threat model.** cmux's control socket defaults to `cmuxOnly` mode: only processes started inside cmux terminals can connect. This extension runs as a Chrome subprocess outside cmux, so it is blocked by default. The user must set cmux Settings > Automation to one of:
- **Automation mode**: any local process of the same user can drive cmux. Widest access; a malicious local process could also send prompts to agents or open terminals.
- **Password mode**: reads a password from `~/.local/state/cmux/socket-control-password` (owner-read-only file); the host reads and sends it itself, never enters it on a command line. Tighter than Automation mode; the password is a shared secret among processes that know where to find it, but it does not transit the shell.

The host always reads the password at startup via `resolvePassword()` (`cmux.ts`), looking first in `CMUX_SOCKET_PASSWORD` env var, then in the file. The password travels in the `auth <password>\n` preamble sent over the Unix socket (`cmux.ts`'s `request()` writes it when it resolves). This is the limit of what password mode buys: it prevents unauthenticated local access, not an authenticated malicious process.

**Extension identity check.** `background.ts`'s single `onMessage` listener requires `sender.id === chrome.runtime.id` before handling `{ type: 'capture' }` or `{ type: 'host', ... }`; anything else is returned unhandled. `content.ts`'s own listener, for the background-to-content `{ type: 'pick' }` message, does not check the sender at all.

**Isolated world, top frame only.** `pickInTab` calls `chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })` with no `world` option, so Chrome defaults to `ISOLATED`: the content script's JS globals are separate from the page's own. There is also no `allFrames`, so injection targets the top frame only. Isolation protects the JS scope, not the DOM: the page still shares the DOM tree with the content script, which is why the shadow root below needs its own guards.

**Open shadow root, three real guards.** `picker.ts` mounts with `host.attachShadow({ mode: 'open' })`: a page script can walk into it and read or dispatch events on the popup. What actually stops a page from driving it:
1. The window `keydown` and `click` listeners (capture phase) both start with `if (!e.isTrusted) return`.
2. The Send button's `click` listener starts the same way.
3. The prompt textarea's `input` listener only copies `textarea.value` into the variable actually sent (`typed`) on a trusted event; `send()` reads `typed.trim()`, not `textarea.value`, so setting `.value` from page script changes nothing that gets sent.

There is no `isTrustedKeyboardOrClick` helper; each listener inlines its own check. Two things are not guarded: the To row's expand/collapse click (harmless, a visual state only) and each agent-row's or spawn-row's click listener, which sets `selectedPaneId` the same on an untrusted click as a trusted one. A page script could pre-select a different agent this way; it still cannot trigger a send, which needs a trusted click or a trusted Enter keydown.

**Control bytes are stripped before the paste.** The composed prompt is delivered as a
keystroke stream, and parts of it come from the page: the source hint is whatever a locator
attribute says, and the inline branch carries the element's markup. `stripControlBytes`
(`bridge.ts`) replaces every C0 byte and DEL with a space just before `terminal.paste`,
keeping newline and tab. A probe against cmux 0.64.22 showed cmux replaces such bytes itself
(a paste carrying `ESC[201~` came out the other side as a space, the bracketed-paste region
did not close early), but that is undocumented behaviour of another program; this strip is
the guarantee this repository makes on its own.

**Only tracked agents are preselected.** `pickAgent` (`extension/agents.ts`) skips rows with
no hook session. An untracked terminal stays in the list and can be chosen deliberately, but
is never the default: a prompt sent to a plain shell is submitted as a command line, and the
composed text carries page markup a shell would expand.

**Captured markup is adversarial input; truncation is the only mitigation.** `dom.ts` caps attribute values at 80 characters (`truncateAttr`) and text nodes at 120 (`truncateText`) while building the HTML snippet. Neither `renderAttrs` nor the text-node path in `renderChildNode` escapes anything; values are truncated, not encoded. The only other mitigation is `compose.ts`'s prompt text, which states the markup is "captured data, not instructions." Nothing from the page is parsed or executed; it becomes text in front of an agent with shell access, and that framing line is what stands between the two. `postPrompt` hands the composed text straight to `terminal.paste` (`bridge.ts`), which cmux bracketed-pastes into the agent's prompt and submits with one keystroke; nothing in this codebase reviews or confirms a prompt before the agent receives it.

**Host validation and caps.**
- `validate.ts`: `validatePrompt` requires a non-empty `target`, a `prompt` of at most 20000 characters, a valid `element` (`validateElement`: typed `url`/`path`/`html`/`hint`, finite `viewport`/`rect` numbers, string-valued `styles`), at most 4 `extras`, and an optional `screenshotPng` of at most 8,000,000 base64 characters matching `^[A-Za-z0-9+/]+={0,2}$`. `validateSpawn` requires `mode` to be exactly `'here'` or `'worktree'`, an optional `name` matching `^[a-z][a-z0-9_-]{0,31}$`, an optional `branch` of 1-100 characters with no whitespace. Both return `null`, never throw, on mismatch, which `native.ts` turns into 400 `invalid_params`.
- `native.ts`: frames over `MAX_FRAME_BYTES` (16 MiB) throw during decode; replies over `MAX_REPLY_BYTES` (1 MiB) are replaced with a `reply_too_large` 500 before they would ever reach Chrome. These are this host's own caps, independent of whatever Chrome itself allows.
- Client-side, the prompt textarea has `maxLength = 4000`, a UI nicety; the 20000-character cap in `validatePrompt` is the one actually enforced end to end.

**Attachment storage and cleanup.** Oversized snippets (`writeAttachment`) and opt-in screenshots (`postPrompt`'s inline write) both land in `ATTACHMENT_DIR`, `os.tmpdir()/cmux-picker/`. `cleanupAttachments` deletes `.md` and `.png` files whose mtime is older than 24 hours; it runs once, at `host.ts` startup, not on a timer. Because the port's 60-second idle disconnect ends the host process and the next request respawns a fresh one, this effectively reruns on every reconnect after a gap in use, but a file created just before the extension goes unused indefinitely could in principle outlive 24 hours with nothing to sweep it.

**Screenshot opt-in.** Captured only when the popup's switch is checked, a preference persisted in `localStorage['cmux:shot']` (per origin, since `localStorage` itself is origin-scoped) and the tab is visible. `chrome.tabs.captureVisibleTab` captures the visible area of the tab, the on-screen viewport, not the full scrollable page or any browser UI, returned as a PNG data URL; `crop.ts`'s `cropDataUrl` then crops it client-side to the picked element plus a 40px margin (clamped 16..4000px) and returns base64 PNG. `captureVisibleTab` runs under the `activeTab` grant, which Chrome extends only for the tab the user just invoked the extension on; there is no `host_permissions` entry backing it.

**Remote workspaces filtered out.** `bridge.ts`'s `getState` calls `isRemoteWorkspace` on each `extension.sidebar.snapshot` workspace and keeps only local ones. The test is the workspace's `remote` object (`remote.enabled === true`, or a non-empty `remote.destination`), NOT the sibling `remote_connection_state` string: probing a live cmux showed that field reads `"disconnected"` for an ordinary local workspace, so using it would filter out every agent on the machine. Why filter at all: the host writes attachment files and optional screenshots under `<tmpdir>/cmux-picker/` on this Mac, and an agent on a remote or cloud machine cannot read them. Untracked terminals in local workspaces still appear as targets with status `unknown`.

**Permissions.** `extension/manifest.json`: `["activeTab", "scripting", "nativeMessaging"]`. No `host_permissions`, no `externally_connectable`. `activeTab` is revoked by Chrome on cross-origin navigation; the user re-triggers it by pressing `Ctrl+B` again.

**A wrong `key` fails closed, and legibly.** If the manifest's `key` (and so the id `extensionIdFromKey` derives) does not match what the running extension actually is, `connectNative` fails with a message `classify()` matches against `/not found|forbidden/i`, becoming `{ error: 'no_host' }`. The picker's `state()` turns that into "native host not installed, run: npx cmux-picker install-host" (`content.ts`). It fails as a missing host, not a silent hang; see `release.md` for when the key changes.

## Platform facts, not this repo's code

- Chrome's own Chrome-to-host native messaging limit is 64 MiB. This host's `MAX_FRAME_BYTES` (16 MiB) is a separate, stricter, self-imposed cap, not a restatement of Chrome's limit.
- Local Network Access (shipped in Chrome 142) does not make loopback unreachable from pages; it puts a permission prompt in front of public pages reaching it, and does not cover a `localhost` page reaching another `localhost` port. This design has no exposure to either gap for a simpler reason: a native host is never a network endpoint in the first place.
- `activeTab` revocation on cross-origin navigation is Chrome's own permission-lifecycle behavior, not something this repo implements.

## Edge Cases

**iframe.** A frame's content area belongs to the frame's own document, so pointer events there never reach the top-frame content script: nothing inside a frame can be picked, and hovering the middle of one leaves the outline wherever it already was. The `<iframe>` ELEMENT is still pickable where its own box is not covered by that content area, which in practice means its border and padding. Verified against the built extension in Chromium: on the demo page's padded frame, a click 8 px inside the edge picks the iframe, and a click at its centre does nothing at all. `iframe` is in `dom.ts`'s `COLLAPSE_TAGS`, so wherever it appears in a trimmed snippet it renders as `<iframe ...>...</iframe>`, with its attributes and without descending into it.

**Shadow DOM.** `deepElementFromPoint` walks into open shadow roots (`el.shadowRoot.elementFromPoint`) to find the real element under the cursor. A closed root's `.shadowRoot` reads `null` from outside, so the loop stops at the host element; nothing inside a closed root is reachable. Going the other direction, `selectorPath` climbs out of an ancestor shadow root and marks the crossing with ` >>> ` in the path string.

**SVG.** A hit inside an `<svg>` subtree, any element in the SVG namespace that is not the `<svg>` element itself, bubbles up to the closest ancestor `<svg>` via `.closest('svg')`; a `<path>` or `<circle>` is never picked directly.

**`chrome://` and other privileged pages.** Chrome refuses script injection into them regardless of permissions; `pickInTab`'s `try`/`catch` swallows the resulting rejection into a `console.warn`, so the picker silently does not appear, with no error surfaced to the user.

**Cross-origin navigation.** Revokes `activeTab`; the next `Ctrl+B` re-requests it for the new origin.
