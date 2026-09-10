# Changelog

All notable changes to this project are documented here. Conventional Commits; a release is a `v*` tag, published from CI over npm trusted publishing.

## [Unreleased]

### Features

- Chrome extension (Manifest V3) plus a native messaging host: pick a DOM element on any page and send it, with a prompt, to a coding agent running in cmux. Initial port from herdr-picker; adapted for cmux's v2 socket protocol and agent-hook session tracking.
- Socket protocol: cmux's NDJSON request/reply over Unix socket at `~/.local/state/cmux/cmux.sock`, with optional `auth <password>` preamble when the socket control mode requires it. Password read from `CMUX_SOCKET_PASSWORD` or `~/.local/state/cmux/socket-control-password`. Mandatory user setting: cmux Settings > Automation must be set to "Automation mode" or "Password mode"; the default "cmuxOnly" mode rejects external processes.
- Picker: `Ctrl+B` (macOS `Control+B`, rebindable at `chrome://extensions/shortcuts`) or the toolbar icon injects the picker into the active tab; hover outline with a chip, click picks and opens the popup, `Esc` closes; no in-page hotkey, so the page's own `Ctrl+B` keeps working.
- Payload: `[cmux-picker]` header; source hints when the page carries locator attributes or a Vue/React dev runtime, `Focus: none, find by selector` otherwise; selector path, trimmed HTML with the picked node marked, computed styles, viewport and rect; oversized snippets go to `<tmpdir>/cmux-picker/`.
- Multi-select: Shift+click adds up to five elements, numbered in the payload.
- Screenshot, opt-in: Chrome captures the visible tab, the content script crops the picked element plus a 40px margin with the outline drawn, the host writes the PNG and references it in the prompt.
- Agents: To field preselecting the last used agent, list grouped by workspace, status from cmux hook session stores (idle/working/blocked/unknown). `+ agent here` (splits cmux's focused surface) and `+ agent in worktree` (creates a sibling git worktree and a new cmux workspace); both need Claude Code integration enabled in cmux Settings. In-flight outline polls the state every 2 seconds until the agent settles.
- Delivery: `terminal.paste` v2 method sends the prompt as one bracketed paste followed by a Return keystroke. If the paste could not be submitted, the popup shows "Waiting at the prompt in cmux, press Enter there to send it" and does not retry (which would paste twice). Unsubmitted state is a normal response, not an error.
- Native host: 4-byte length-prefixed JSON frames over stdio, `state`/`prompt`/`spawn` routes, frame cap 16 MiB, reply cap 1 MiB, port closed by the service worker after 60 seconds idle.
- `npx cmux-picker install-host [--socket] [--extension-id] [--browser-dir]`: copies the host to `~/.config/cmux-picker/`, writes the wrapper script with the absolute node path, registers the host manifest with Chrome and Chromium (macOS only).
- Guards: only the extension's own content scripts reach the service worker; the picker starts from a `runtime.onMessage` trigger the page cannot send, ignores untrusted click/keydown/Send events and sends only text typed through trusted input events; the host validates every request.
- Remote workspaces filtered out: agents in remote or cloud workspaces do not appear; local workspaces only (the host cannot read attachment files on a remote machine).
- Degradation: host not installed, cmux down or unreachable, or socket control mode set to cmuxOnly all fall back to copying the prompt to the clipboard with the reason shown in the popup; blocked agents are disabled in the list.
- Tooling: TypeScript strict, Vite builds (host + CLI, unpacked extension), Vitest with a fake cmux socket, Playwright end-to-end loading the unpacked extension with the host wired to the fake, GitHub Actions CI and tag-driven npm release with provenance.
- Demo: `npm run demo` serves a checked-in page (`demo/index.html`) with 18 cards, one pickable element each and the payload it should produce written next to it. `npm run demo:gif` re-records `README.md`'s hero GIF end to end against a fake cmux socket (`e2e/demo-gif.spec.ts`, needs ffmpeg).

