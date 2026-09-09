# Changelog

All notable changes to this project are documented here. Conventional Commits; a release is a `v*` tag, published from CI over npm trusted publishing.

## [Unreleased]

### Build/Tooling

- Chrome Web Store material: `store/listing.md` (every dashboard field), `PRIVACY.md`, and `npm run store-assets`, a gated Playwright spec that renders the screenshots, promo tile and store icon from the built extension against the fake cmux.

## [0.1.1] - 2026-09-09

### Bug Fixes

- CLI: `dist/cli.js` now starts with `#!/usr/bin/env node`, so the bin npm links (`npx cmux-picker install-host`) runs; 0.1.0 shipped it without the shebang and the shell tried to run the bundle as a script. An end-to-end test now packs and installs the package and runs the bin.

## [0.1.0] - 2026-09-09

### Features

- Chrome extension (Manifest V3) plus a native messaging host: pick a DOM element on any page and send it, with a prompt, to a coding agent running in cmux. Modules copied from vite-plugin-cmux at `f5ef5e1` (see `UPSTREAM.md`) and adapted; no dependency between the two projects.
- Picker: `Ctrl+B` (macOS `Control+B`, rebindable at `chrome://extensions/shortcuts`) or the toolbar icon injects the picker into the active tab; hover outline with a chip, click picks and opens the popup, `Esc` closes; no in-page hotkey, so the page's own `Ctrl+B` keeps working.
- Payload: same format as the plugin with a `[cmux-picker]` header; source hints when the page carries locator attributes or a Vue/React dev runtime, `Focus: none, find by selector` otherwise; selector path, trimmed HTML with the picked node marked, computed styles, viewport and rect; oversized snippets go to `<tmpdir>/cmux-picker/`.
- Multi-select: Shift+click adds up to five elements, numbered in the payload.
- Screenshot, opt-in: Chrome captures the visible tab, the content script crops the picked element plus a 40px margin with the outline drawn, the host writes the PNG and references it in the prompt; every OS Chrome runs on.
- Agents: To field preselecting the last used agent, list grouped by workspace, `+ agent here` (splits cmux's focused pane) and `+ agent in worktree`; in-flight outline polling the state every 2 seconds until the agent settles.
- Native host: 4-byte length-prefixed JSON frames over stdio, `state`/`prompt`/`spawn` mirroring the plugin's routes, frame cap 16 MiB, reply cap 1 MiB, port closed by the service worker after 60 seconds idle.
- `npx cmux-picker install-host [--socket] [--extension-id] [--browser-dir]`: copies the host to `~/.config/cmux-picker/`, writes the wrapper script with the absolute node path, registers the host manifest with every Chrome and Chromium install found (macOS, Linux).
- Guards: only the extension's own content scripts reach the service worker; the picker starts from a `runtime.onMessage` trigger the page cannot send, ignores untrusted click/keydown/Send events and sends only text typed through trusted input events; the host validates every request.
- Degradation: host not installed, cmux down or too old fall back to copying the prompt to the clipboard with the reason in the popup; blocked agents are disabled in the list.
- Tooling: TypeScript strict, Vite builds (host + CLI, unpacked extension), Vitest with a fake cmux socket, Playwright end-to-end loading the unpacked extension with the host wired to the fake, GitHub Actions CI and tag-driven npm release with provenance.
