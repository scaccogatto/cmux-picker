---
type: Runbook
title: Release versioning and publication
description: Steps to cut a release, what the tag-triggered workflow does, npm trusted publishing, and the Chrome Web Store upload
tags: [release, versioning, npm, chrome-web-store, conventional-commits, runbook]
generated:
  by: claude/sonnet-5
  at: 2026-09-09
status: stable
sources:
  - resource: ../CHANGELOG.md
  - resource: ../package.json
  - resource: ../extension/manifest.json
  - resource: ../.github/workflows/release.yml
  - resource: ../.github/workflows/ci.yml
---

## Cutting a release

1. **Bump both version fields.** `package.json`'s `version` and `extension/manifest.json`'s `version`. For the first release both are already `0.1.0`. Nothing in `scripts`, `ci.yml`, or `release.yml` checks that the two match; keeping them in sync is a convention, not something enforced.
2. **Update `CHANGELOG.md`.** Move the `[Unreleased]` entries into a new dated section for the version. There is no prior dated section yet: this repo has not cut a release.
3. **Commit, tag, push the tag:**
   ```sh
   git add package.json extension/manifest.json CHANGELOG.md
   git commit -m "chore: release 0.1.0"
   git tag v0.1.0
   git push origin v0.1.0
   ```

## What `release.yml` actually does

Triggers on a `v*` tag push or `workflow_dispatch`. Steps, in order: `npm ci`, `npm run build`, `npm install -g npm@latest`, a version-already-published check, then a conditional publish.

- **No explicit `typecheck` or `test` step in this workflow.** Those run in `ci.yml`, which triggers on a push to `master`/`main` and on pull requests (`Lint`, `Typecheck`, `Test` which is `npm run coverage`, `Build`, then a Playwright browser install and `E2E`), not here. A tag push does not trigger `ci.yml` at all, and a feature-branch push with no open PR runs nothing.
- **But `npm publish` triggers them anyway.** `package.json`'s `"prepublishOnly": "npm run typecheck && npm run test && npm run build"` runs automatically as an npm lifecycle hook on any `npm publish`, in CI or by hand. So the workflow's explicit `npm run build` and the one inside `prepublishOnly` both run; the build step happens twice. `prepublishOnly` runs `test` (`vitest run`), not `coverage`, `lint`, or `e2e`; those three are exercised only by CI on the push that preceded the tag, never by the release workflow or by `npm publish` itself.
- **`npm install -g npm@latest`** upgrades the runner's npm to a version new enough for OIDC trusted publishing (npm 11.5.1 or later; an older npm does not speak the trusted-publisher exchange).
- **Version check:** reads `name` and `version` from `package.json`, runs `npm view "$NAME@$VERSION" version`, and sets `published=true` if that succeeds. The publish step only runs `if: steps.check.outputs.published == 'false'`, so re-running the workflow or pushing a duplicate tag is safe: it never double-publishes.
- **Publish:** `npm publish --provenance` at `NPM_CONFIG_LOGLEVEL: verbose`, with job `permissions: id-token: write` and no `NODE_AUTH_TOKEN` anywhere; `setup-node` runs without `registry-url`, which would plant an `_authToken=${NODE_AUTH_TOKEN}` placeholder in `.npmrc` that turns a failed OIDC exchange into a misleading `E404`. At verbose level a failed exchange logs `oidc Failed token exchange request with body message: ...` (`package not found` = no trusted publisher matches the run). The workflow's own comment notes that a token present would make npm skip OIDC.

## One-time trusted-publishing bootstrap

A trusted publisher attaches to a package that already exists (npm/cli#8544 tracks first-publish support), so `0.1.0` has to be published by hand, once, with a maintainer's own npm account and 2FA:

1. `npm login` (browser flow).
2. From a clean checkout of the `v0.1.0` tag: `npm ci`, then `npm publish`. `prepublishOnly` runs typecheck, test, and build first; npm asks for 2FA in the browser. No `--provenance` here; only CI can attest that.
3. On npmjs.com: package `cmux-picker`, Settings, Trusted publishing, GitHub Actions:
   - Organization or user: `scaccogatto`
   - Repository: `cmux-picker`
   - Workflow filename: `release.yml`
   - No environment.
   - Allowed actions: also permit direct publishing with `npm publish`. Configurations created after 2026-09-03 default to `npm stage publish` only, and `release.yml` runs `npm publish`: without this the OIDC exchange succeeds and the PUT fails with `E403 OIDC permission denied for this action`.
4. Then Publishing access, "Require two-factor authentication and disallow tokens," so no token can ever publish this package again; trusted publishers keep working, they use OIDC tokens, not npm tokens.
5. `npm logout` (removes the login token from `~/.npmrc`).
6. Push the `v0.1.0` tag (from "Cutting a release" above) **after** this bootstrap, not before. Pushed early, `release.yml`'s version-check step finds `0.1.0` not yet on the registry, so its publish step still runs `npm publish --provenance`, but no trusted publisher is configured yet and that run fails; it does not double-publish, it just fails red until re-triggered (`workflow_dispatch`) after the bootstrap above. Pushed after, the check finds `0.1.0` already on the registry and skips the publish step cleanly. Every later version is published by the workflow over OIDC, with provenance.

Nothing from this bootstrap is stored in the repo, in GitHub secrets, or on any machine afterward.

## Extension zip and Chrome Web Store

Copy for every dashboard field, the developer-account prerequisites and the asset list live in `store/listing.md`; `npm run store-assets` regenerates the PNGs there from the built extension against the fake cmux.

First submission, in this order:

1. **Draft upload, to harvest the Store key.** The dashboard rejects a manifest `key` that does not belong to an existing item ("key field is not allowed in manifest"), so the first zip is built without it, from a copy so `dist/` stays intact:
   ```sh
   npm run build
   rm -rf /tmp/cmux-picker-store && cp -R dist/extension /tmp/cmux-picker-store
   node -e "const fs=require('fs'),f='/tmp/cmux-picker-store/manifest.json',m=JSON.parse(fs.readFileSync(f,'utf8'));delete m.key;fs.writeFileSync(f,JSON.stringify(m,null,2)+'\n')"
   (cd /tmp/cmux-picker-store && zip -r "$OLDPWD/cmux-picker-<version>-store.zip" .)
   ```
   Developer dashboard, Add new item, upload it, do not submit.
2. **Package tab, View public key.** Copy the text between the BEGIN/END lines, remove the newlines, put it in `extension/manifest.json` `key`. From then on every build, the unpacked one included, runs under the Store's id, and `install-host` derives that id (`extensionIdFromKey` in `cli.ts`).
3. **Patch release with the new key.** Bump `package.json` and `extension/manifest.json`, changelog, commit, tag, push the tag: CI publishes the npm version whose bundled extension carries the Store key.
4. **Replace the draft's package.** `npm run build`, `(cd dist/extension && zip -r ../../cmux-picker-<version>.zip .)` (the key matches now, keep it), upload it in the draft's Package tab. Fill Store listing, Privacy practices and Distribution from `store/listing.md`. Before submitting, run the manual check once on the real path: load the new `dist/extension/` unpacked, `Ctrl+B` on any page, screenshot switch on, send: the prompt must carry a `Screenshot:` line and the PNG must exist under the temp directory. Submit for review.
5. **Machines that had the old unpacked build.** Its id no longer matches the host manifest: remove it in `chrome://extensions`, load the new `dist/extension/` or install from the Store, re-run `npx cmux-picker install-host`.

Later versions: zip `dist/extension/` as is and upload it as a new version; the key never changes again.

## Unpacked loading (interim distribution)

Until the Chrome Web Store listing is live, `chrome://extensions`, Developer mode, Load unpacked, `dist/extension/` is the distribution path. The repo's own `manifest.json` `key` (checked in) keeps this build's extension id stable across reloads and machines, so `install-host`'s derived id keeps matching without needing `--extension-id`.

## Versioning

Semantic Versioning: MAJOR.MINOR.PATCH, starting at 0.1.0. Bump:
- PATCH: bug fixes, internal refactors.
- MINOR: new features.
- MAJOR: breaking changes to the extension payload, the CLI flags, or the minimum cmux protocol version this expects (`bridge.ts`'s `getState` currently requires `protocol >= 20`).

## Commits

Conventional Commits: `<type>(<scope>): <subject>`, plus an optional body and footer.

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `ci`.
Scope: optional, for example `extension`, `host`, `cli`, `e2e`.
Subject: imperative mood, lowercase, no period.

Example: `feat(extension): add multi-select for up to 5 elements`

## Changelog

Manual entries in `CHANGELOG.md` under `[Unreleased]` sections (Features, Bug Fixes, Build/Tooling). On release, move them into a new dated version section.

## Pre-publish checklist

`npm publish`'s own `prepublishOnly` hook only covers typecheck, test, and build. Everything else needs to be run and checked by hand before tagging:
- `npm run lint`
- `npm run coverage` (a superset of `test`, with the coverage report)
- `npm run e2e` (needs `npx playwright install --with-deps chromium` first, as `ci.yml` does); it also packs and installs the package and runs the bin link the way npx does (`e2e/package.spec.ts`), the check 0.1.0 shipped without
- `npm run build` clean, with no uncommitted output
- No uncommitted changes
- `package.json` and `extension/manifest.json` versions match (a convention, not enforced by tooling)
- Tag matches the version
- CI green on the commit being tagged (`ci.yml` only runs on a push to `master`/`main` or a pull request, so this only applies when that commit reached CI one of those ways)
