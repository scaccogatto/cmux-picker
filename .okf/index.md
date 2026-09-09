---
okf_version: '0.2'
---

# cmux-picker - DOM picker to cmux agents, on any page

Pick a DOM element on any page open in Chrome and send it, with a prompt, to a coding agent running in cmux. Bridge from the browser through the extension's service worker, a native messaging host and cmux's socket protocol. Sibling of vite-plugin-cmux, which does the same for pages served by your own Vite dev server; the two projects share no code at runtime, the shared modules were copied (see `UPSTREAM.md`).

## Concepts

- [architecture.md](./architecture.md): Extension, native host, and CLI module breakdown; relay-based picker; screenshot capture by Chrome.
- [security.md](./security.md): Native messaging isolation, content as data, page-driven UI guards, screenshot opt-in, permissions.
- [release.md](./release.md): Versioning (SemVer, Conventional Commits), npm trusted publishing, Chrome Web Store steps, manifest key replacement on first upload.
