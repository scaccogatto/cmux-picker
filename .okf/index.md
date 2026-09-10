---
okf_version: '0.2'
---

# cmux-picker - DOM picker to cmux agents, on any page

Pick a DOM element on any page open in Chrome and send it, with a prompt, to a coding agent running in cmux on your own machine. Bridge from the browser through the extension's service worker, a native messaging host and cmux's v2 socket protocol. Sibling of vite-plugin-herdr (pages served by Vite) and herdr-picker (the same for herdr); the projects share no code at runtime. Only the documented cmux protocol is used; nothing is copied from cmux (GPL-3.0).

## Concepts

- [architecture.md](./architecture.md): Extension, native host, and CLI module breakdown; cmux socket protocol (NDJSON, optional auth preamble, method routing); relay-based picker; screenshot capture by Chrome.
- [security.md](./security.md): Native messaging isolation, content as data, page-driven UI guards, screenshot opt-in, permissions; socket access control modes as part of the threat model (cmuxOnly/Automation/Password).
- [release.md](./release.md): Versioning (SemVer, Conventional Commits), npm trusted publishing, Chrome Web Store steps, manifest key replacement on first upload.
