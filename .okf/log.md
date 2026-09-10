# Update Log

## 2026-09-10

An adversarial review (95 agents, three verifiers per finding) produced 15 upheld findings.
The one rated high, page-controlled ESC bytes escaping the bracketed-paste region, does not
reproduce: cmux replaces those bytes itself, verified by probe. `stripControlBytes` was added
anyway so the guarantee does not rest on another program's undocumented behaviour. The
findings that were real: a plain shell could be preselected as the agent target, the
in-flight overlay never cleared when a target never reported working, socket replies were
decoded per chunk (breaking a multi-byte character split across reads), `focused` was
per-window rather than global, `rev-parse --verify` accepted a tag so a worktree could detach
HEAD, the password was resolved once per host process, and spawn skipped the remote-workspace
filter that `getState` applies. Six test defects were fixed alongside, including guard tests
that passed with the guard deleted and a host smoke test whose path never existed.

Live verification against cmux 0.64.22 (socket in automation mode) corrected five field paths taken from the docs: surfaces sit under `workspace.panes[].surfaces[]`, the sidebar snapshot keys workspaces by `id`, the branch is `branch_summary`, `remote_connection_state` reads `disconnected` for a local workspace (so the remote test is the `remote` object), and the hook store has no `activeSessionsBySurface`. The three real payloads are checked in under `src/__tests__/fixtures/cmux/`.

Two behaviours were also found by probing rather than reading: `terminal.paste` delivers the whole prompt as one bracketed-paste chunk when the receiving TUI has enabled DECSET 2004, and `initial_input` on `surface.split` / `workspace.create` does not start the command, so `spawnAgent` types `claude` into the new surface and presses Enter instead. A first-run trust prompt keeps the agent from starting a session, which surfaces as `agent_not_ready` with nothing sent.

Repository created as a copy of herdr-picker with global `herdr` → `cmux` rename. All code retargeted to cmux's v2 socket protocol.

Socket transport rewritten: `src/cmux.ts` (new) replaces herdr-specific connection logic with NDJSON framing over Unix socket, optional `auth <password>` preamble, and reply envelope parsing (`{id, ok, result}` or `{id, ok:false, error}`). Password resolution from env or file `~/.local/state/cmux/socket-control-password`.

Bridge module rewritten for cmux methods: `getState` gates on `system.capabilities`, calls `system.tree` and `extension.sidebar.snapshot`, reads hook session stores from `~/.cmuxterm/<agent>-hook-sessions.json`. Agent status mapped from hook lifecycle (`running`/`idle`/`needsInput`/`unknown` → `working`/`idle`/`blocked`/`unknown`). Remote workspaces filtered out. `postPrompt` uses `terminal.paste` with `submit_key:'return'`, maps `submitted:false` to a 200 response (not an error). `spawnAgent` uses `surface.split` or `git worktree add` + `workspace.create`, polls hook stores for the new surface id.

Native host updated: password option threaded through `createHandler` into every bridge call. `httpStatus` mapping updated for cmux error codes.

In-flight polling grace window increased from 5s to 15s to tolerate the asynchronous Claude Code `prompt-submit` hook.

Documentation: README.md updated for macOS-only, mandatory socket mode setting (Automation/Password), overlap with cmux's built-in browser. CHANGELOG.md reset to single Unreleased entry. PRIVACY.md updated for socket-only delivery. CLAUDE.md updated for fake-cmux and CMUX_PICKER_STATE_DIR conventions. store/listing.md adapted for cmux. All .okf/ concepts regenerated for cmux protocol, socket access control as threat model, generated field updated.

Repository presentation rebuilt to match the sibling project vite-plugin-herdr: a centered header block in `README.md` with `.github/logo.svg` (440x120, the picker glyph plus the wordmark in the extension's own accent `#A99BFF` on `#1F1E2E`), `.github/icon.svg`, a CI and a licence badge, and `.github/demo.gif` as the hero. The GIF is produced by `e2e/demo-gif.spec.ts` (`npm run demo:gif`), a reproducible Playwright recording of the whole loop against a fake cmux socket: arm, hover, pick, type, open the agent list, choose an agent in another workspace, send, watch the in-flight outline settle to DONE. The README gained a "How it compares" table (cmux design-mode/react-grab, claude-code-browser, vite-plugin-ai-annotator) drawn from the prior-art sweep, and its install instructions were corrected: the package is not on npm, so `npm install cmux-picker` and `npx cmux-picker install-host` were replaced by a clone-and-build path with `node dist/cli.js install-host`.

