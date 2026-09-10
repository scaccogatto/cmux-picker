# Update Log

## 2026-09-10

Live verification against cmux 0.64.22 (socket in automation mode) corrected five field paths taken from the docs: surfaces sit under `workspace.panes[].surfaces[]`, the sidebar snapshot keys workspaces by `id`, the branch is `branch_summary`, `remote_connection_state` reads `disconnected` for a local workspace (so the remote test is the `remote` object), and the hook store has no `activeSessionsBySurface`. The three real payloads are checked in under `src/__tests__/fixtures/cmux/`.

Two behaviours were also found by probing rather than reading: `terminal.paste` delivers the whole prompt as one bracketed-paste chunk when the receiving TUI has enabled DECSET 2004, and `initial_input` on `surface.split` / `workspace.create` does not start the command, so `spawnAgent` types `claude` into the new surface and presses Enter instead. A first-run trust prompt keeps the agent from starting a session, which surfaces as `agent_not_ready` with nothing sent.

Repository created as a copy of herdr-picker with global `herdr` → `cmux` rename. All code retargeted to cmux's v2 socket protocol.

Socket transport rewritten: `src/cmux.ts` (new) replaces herdr-specific connection logic with NDJSON framing over Unix socket, optional `auth <password>` preamble, and reply envelope parsing (`{id, ok, result}` or `{id, ok:false, error}`). Password resolution from env or file `~/.local/state/cmux/socket-control-password`.

Bridge module rewritten for cmux methods: `getState` gates on `system.capabilities`, calls `system.tree` and `extension.sidebar.snapshot`, reads hook session stores from `~/.cmuxterm/<agent>-hook-sessions.json`. Agent status mapped from hook lifecycle (`running`/`idle`/`needsInput`/`unknown` → `working`/`idle`/`blocked`/`unknown`). Remote workspaces filtered out. `postPrompt` uses `terminal.paste` with `submit_key:'return'`, maps `submitted:false` to a 200 response (not an error). `spawnAgent` uses `surface.split` or `git worktree add` + `workspace.create`, polls hook stores for the new surface id.

Native host updated: password option threaded through `createHandler` into every bridge call. `httpStatus` mapping updated for cmux error codes.

In-flight polling grace window increased from 5s to 15s to tolerate the asynchronous Claude Code `prompt-submit` hook.

Documentation: README.md updated for macOS-only, mandatory socket mode setting (Automation/Password), overlap with cmux's built-in browser. CHANGELOG.md reset to single Unreleased entry. PRIVACY.md updated for socket-only delivery. CLAUDE.md updated for fake-cmux and CMUX_PICKER_STATE_DIR conventions. store/listing.md adapted for cmux. All .okf/ concepts regenerated for cmux protocol, socket access control as threat model, generated field updated.
