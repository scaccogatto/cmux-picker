# Update Log

## 2026-09-09

Repository bootstrapped: configs adapted from vite-plugin-cmux, shared modules copied at f5ef5e1 (see UPSTREAM.md).

Core modules adapted for the extension: relay-based picker (no HTTP/HMR), screenshotPng instead of ScreenshotRequest (base64 PNG captured by extension), no dev-server screencapture, trusted-event guards on UI, no in-page hotkey.

Documentation landed: README.md (use, install, security), CHANGELOG.md (Keep a Changelog format), architecture.md (modules, contracts, message flow), security.md (boundaries, guards, edge cases), release.md (versioning, npm/Web Store steps). First release pending.

0.1.0 published to npm by hand (trusted-publishing bootstrap), tag v0.1.0 pushed, the release workflow found it on the registry and skipped the publish. The published bin failed under npx: dist/cli.js had no shebang, so the shell ran the bundle as a script. 0.1.1 adds the shebang to src/cli.ts (the Vite build keeps it) and e2e/package.spec.ts, which packs and installs the package and runs the bin link the way npx does.

Trusted publishing bootstrap findings: a trusted publisher created after 2026-09-03 allows only `npm stage publish` until "Allowed actions" also permits direct `npm publish` (otherwise `E403 OIDC permission denied for this action` after a successful token exchange); `setup-node`'s `registry-url` plants an unresolved `${NODE_AUTH_TOKEN}` in `.npmrc` that turns a failed exchange into `E404`. release.yml dropped `registry-url` and publishes at verbose log level; release.md updated.

Chrome Web Store material prepared: store/listing.md, PRIVACY.md, store assets spec (npm run store-assets); release.md store section rewritten as an ordered first-submission sequence (draft upload without the manifest key, harvest the Store key, patch release, replace the package, submit).
