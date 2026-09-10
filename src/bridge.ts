import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { composePrompt, renderAttachment } from './compose.ts'
import { CmuxError, request } from './cmux.ts'
import type {
  AgentRow,
  AgentStatus,
  ElementInfo,
  PromptRequest,
  PromptResponse,
  SpawnRequest,
  SpawnResponse,
  StateResponse,
  WorkspaceRow,
} from './types.ts'

/** Default directory for oversized element snippet attachments */
export const ATTACHMENT_DIR = join(tmpdir(), 'cmux-picker')

/** cmux methods getState requires before it will report cmux: true */
const REQUIRED_METHODS = ['terminal.paste', 'system.tree', 'extension.sidebar.snapshot', 'surface.split', 'workspace.create']

function str(x: unknown): string | null {
  return typeof x === 'string' ? x : null
}

function obj(x: unknown): Record<string, unknown> | null {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null
}

function stripBranchIcon(raw: string | null): string | null {
  if (raw === null) return null
  const trimmed = raw.trim()
  const code = trimmed.codePointAt(0)
  if (code !== undefined && code >= 0xe000 && code <= 0xf8ff) {
    return trimmed.slice(1).trimStart()
  }
  return trimmed
}

/**
 * Whether a sidebar-snapshot workspace is backed by a machine other than this
 * Mac: true when its `remote` object has `enabled === true` (equivalently a
 * non-empty `remote.destination`). A missing `remote` object means local.
 *
 * Trap: `remote_connection_state` is NOT the signal to test here, despite the
 * name. cmux sets it to the string "disconnected" for an ordinary LOCAL
 * workspace with no remote configured at all, so treating it as the primary
 * local/remote test (e.g. "!== 'local'") reads every local workspace as
 * remote and silently drops every agent on the machine. Use it only as a
 * secondary detail, never as the test itself.
 */
function isRemoteWorkspace(sidebarWorkspace: Record<string, unknown> | null): boolean {
  const remote = obj(sidebarWorkspace?.remote)
  if (!remote) return false
  if (remote.enabled === true) return true
  return str(remote.destination) !== null && str(remote.destination) !== ''
}

function mapLifecycle(lifecycle: string | null): AgentStatus {
  switch (lifecycle) {
    case 'running':
      return 'working'
    case 'idle':
      return 'idle'
    case 'needsInput':
      return 'blocked'
    default:
      return 'unknown'
  }
}

/** Maps a system.tree terminal surface plus its resolved context to the AgentRow shape sent to the client */
export function toAgentRow(
  surface: Record<string, unknown>,
  ctx: { workspaceId: string; branch: string | null; workspaceCwd: string | null; hookSession: HookSessionInfo | null },
): AgentRow {
  return {
    pane_id: str(surface.id) ?? '',
    workspace_id: ctx.workspaceId,
    agent_status: mapLifecycle(ctx.hookSession?.lifecycle ?? null),
    agent: ctx.hookSession?.agent ?? null,
    title: str(surface.title),
    branch: ctx.branch,
    session: ctx.hookSession?.sessionId ?? null,
    focused: Boolean(surface.focused),
    cwd: ctx.hookSession?.cwd ?? ctx.workspaceCwd,
  }
}

/** Maps a system.tree workspace object to the WorkspaceRow shape sent to the client */
export function toWorkspaceRow(w: Record<string, unknown>): WorkspaceRow {
  return {
    workspace_id: str(w.id) ?? '',
    label: str(w.title),
    number: typeof w.index === 'number' && Number.isFinite(w.index) ? w.index + 1 : null,
    focused: Boolean(w.selected),
  }
}

/**
 * Rewrites a relative source hint ("path:line[:col][suffix]") to an absolute
 * path resolved against roots; for relative paths, tries each root in order
 * and returns the first whose file exists, or falls back to the first root.
 * Hints that are already absolute or don't match the pattern pass through unchanged.
 */
export function absolutizeHint(hint: string | null, roots: string[]): string | null {
  if (hint === null) return null

  const match = hint.match(/^(\S+?):(\d+)(?::(\d+))?(.*)$/)
  if (!match) return hint

  const path = match[1]
  const line = match[2]
  const col = match[3]
  const rest = match[4] ?? ''
  if (!path || !line) return hint
  if (isAbsolute(path)) return hint

  const root = roots.find((r) => existsSync(resolve(r, path))) ?? roots[0]
  if (root === undefined) return hint

  const colPart = col ? `:${col}` : ''
  return `${resolve(root, path)}:${line}${colPart}${rest}`
}

/** One cmux hook-tracked agent session, resolved for the surface it is bound to */
export interface HookSessionInfo {
  sessionId: string
  lifecycle: string | null
  cwd: string | null
  /** Unix seconds (fractional), as the store writes it; null when missing or not a number */
  updatedAt: number | null
  agent: string
}

/**
 * Last good parse of each hook store file, keyed by absolute path. cmux's
 * hook CLI processes rewrite these files, so a read can catch one
 * half-written; on a parse/read failure the previous good parse is served
 * instead of losing every agent's status.
 */
const hookStoreCache = new Map<string, Record<string, unknown>>()

async function readHookStoreFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    const parsedObj = obj(parsed)
    if (!parsedObj) throw new Error('hook store is not a JSON object')
    hookStoreCache.set(filePath, parsedObj)
    return parsedObj
  } catch {
    return hookStoreCache.get(filePath) ?? null
  }
}

/** Numeric updatedAt (unix seconds, fractional) off a raw session object, or null when missing/not a number */
function sessionUpdatedAt(session: Record<string, unknown>): number | null {
  return typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt) ? session.updatedAt : null
}

function toHookSessionInfo(session: Record<string, unknown>, sessionId: string, agent: string): HookSessionInfo {
  return {
    sessionId,
    lifecycle: str(session.agentLifecycle),
    cwd: str(session.cwd),
    updatedAt: sessionUpdatedAt(session),
    agent,
  }
}

/**
 * Reads every <stateDir>/*-hook-sessions.json store cmux's CLI hooks write
 * and returns one HookSessionInfo per tracked surface across every agent's
 * store file. The real store is just {version, sessions}, each session
 * carrying its own surfaceId; when a store also has a non-empty
 * activeSessionsBySurface index (newer cmux may populate one), that index is
 * preferred. Otherwise sessions is folded by surfaceId ourselves, keeping the
 * entry with the greatest numeric updatedAt per surface. A missing stateDir,
 * or a store with no usable data, contributes nothing rather than throwing.
 */
export async function readHookSessions(stateDir: string): Promise<Map<string, HookSessionInfo>> {
  const result = new Map<string, HookSessionInfo>()

  let entries: string[]
  try {
    entries = await readdir(stateDir)
  } catch {
    return result
  }

  const storeSuffix = '-hook-sessions.json'
  for (const name of entries) {
    if (!name.endsWith(storeSuffix)) continue
    const agent = name.slice(0, -storeSuffix.length)

    const store = await readHookStoreFile(join(stateDir, name))
    if (!store) continue

    const sessions = obj(store.sessions) ?? {}
    const active = obj(store.activeSessionsBySurface)

    if (active && Object.keys(active).length > 0) {
      for (const [surfaceId, activeEntryRaw] of Object.entries(active)) {
        const activeEntry = obj(activeEntryRaw)
        const sessionId = activeEntry ? str(activeEntry.sessionId) : null
        if (!sessionId) continue

        const session = obj(sessions[sessionId])
        if (!session) continue

        result.set(surfaceId, toHookSessionInfo(session, sessionId, agent))
      }
      continue
    }

    for (const [sessionId, sessionRaw] of Object.entries(sessions)) {
      const session = obj(sessionRaw)
      const surfaceId = session ? str(session.surfaceId) : null
      if (!session || !surfaceId) continue

      const candidate = toHookSessionInfo(session, sessionId, agent)
      const existing = result.get(surfaceId)
      if (existing && (existing.updatedAt ?? -Infinity) >= (candidate.updatedAt ?? -Infinity)) continue
      result.set(surfaceId, candidate)
    }
  }

  return result
}

/** Default state directory for the cmux hook session stores, override CMUX_PICKER_STATE_DIR for tests */
function defaultStateDir(): string {
  return process.env.CMUX_PICKER_STATE_DIR ?? join(homedir(), '.cmuxterm')
}

/** Builds a workspace id -> sidebar-snapshot workspace lookup from an extension.sidebar.snapshot result */
function sidebarWorkspaceMap(sidebar: Record<string, unknown> | null): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>()
  const workspaces = sidebar && Array.isArray(sidebar.workspaces) ? sidebar.workspaces : []
  for (const raw of workspaces) {
    const w = obj(raw)
    if (!w) continue
    const id = str(w.id) ?? str(w.workspace_id)
    if (id) map.set(id, w)
  }
  return map
}

/**
 * A system.tree workspace's surface nodes: real cmux nests them two levels
 * down, workspace.panes[].surfaces[], not directly on the workspace. Falls
 * back to a top-level workspace.surfaces[] if one is ever present.
 */
function workspaceSurfaces(workspace: Record<string, unknown>): Record<string, unknown>[] {
  const panes = Array.isArray(workspace.panes) ? workspace.panes : []
  const fromPanes = panes.flatMap((paneRaw) => {
    const pane = obj(paneRaw)
    const surfaces = pane && Array.isArray(pane.surfaces) ? pane.surfaces : []
    return surfaces.map((s) => obj(s)).filter((s): s is Record<string, unknown> => s !== null)
  })
  if (fromPanes.length > 0) return fromPanes

  const direct = Array.isArray(workspace.surfaces) ? workspace.surfaces : []
  return direct.map((s) => obj(s)).filter((s): s is Record<string, unknown> => s !== null)
}

/**
 * Finds the focused workspace id and, within it, the focused surface id in a
 * system.tree result. Prefers the tree's top-level `active` pointer
 * (workspace_id/surface_id), which is null when no cmux window is key;
 * falling back to the window's selected_workspace_id and that workspace's
 * focused-or-selected surface.
 */
function findFocusedIds(tree: Record<string, unknown> | null): { workspaceId: string | null; surfaceId: string | null } {
  const active = obj(tree?.active)
  const activeWorkspaceId = active ? str(active.workspace_id) : null
  if (activeWorkspaceId) {
    return { workspaceId: activeWorkspaceId, surfaceId: str(active?.surface_id ?? null) }
  }

  const windows = tree && Array.isArray(tree.windows) ? tree.windows : []
  for (const windowRaw of windows) {
    const window = obj(windowRaw)
    const selectedWorkspaceId = window ? str(window.selected_workspace_id) : null
    if (!selectedWorkspaceId) continue

    const workspaces = Array.isArray(window?.workspaces) ? window.workspaces : []
    const workspace = workspaces.map((w) => obj(w)).find((w) => w && str(w.id) === selectedWorkspaceId) ?? null
    if (!workspace) return { workspaceId: selectedWorkspaceId, surfaceId: null }

    const surfaces = workspaceSurfaces(workspace)
    const focusedSurface = surfaces.find((s) => s.focused === true) ?? surfaces.find((s) => s.selected === true) ?? null
    return { workspaceId: selectedWorkspaceId, surfaceId: focusedSurface ? str(focusedSurface.id) : null }
  }

  return { workspaceId: null, surfaceId: null }
}

/** Finds the workspace id and title owning a given surface id in a system.tree result */
function findSurfaceContext(tree: Record<string, unknown> | null, surfaceId: string): { workspaceId: string; title: string | null } | null {
  const windows = tree && Array.isArray(tree.windows) ? tree.windows : []
  for (const windowRaw of windows) {
    const window = obj(windowRaw)
    const workspaces = window && Array.isArray(window.workspaces) ? window.workspaces : []

    for (const workspaceRaw of workspaces) {
      const workspace = obj(workspaceRaw)
      if (!workspace) continue

      for (const surface of workspaceSurfaces(workspace)) {
        if (str(surface.id) === surfaceId) {
          return { workspaceId: str(workspace.id) ?? '', title: str(surface.title) }
        }
      }
    }
  }
  return null
}

/**
 * Resolves a sidebar-snapshot workspace's project root: project_root_path,
 * else root_path, else current_directory.
 */
function workspaceRoot(sidebarWorkspace: Record<string, unknown> | null): string | null {
  if (!sidebarWorkspace) return null
  return str(sidebarWorkspace.project_root_path) ?? str(sidebarWorkspace.root_path) ?? str(sidebarWorkspace.current_directory)
}

/**
 * Resolves a sidebar-snapshot workspace's branch: branch_summary, else the
 * first entry of git_branches, either way stripped of a leading icon glyph.
 */
function workspaceBranch(sidebarWorkspace: Record<string, unknown> | null): string | null {
  if (!sidebarWorkspace) return null
  const summary = str(sidebarWorkspace.branch_summary)
  if (summary !== null) return stripBranchIcon(summary)

  const branches = Array.isArray(sidebarWorkspace.git_branches) ? sidebarWorkspace.git_branches : []
  const first = obj(branches[0])
  return stripBranchIcon(first ? str(first.branch) : null)
}

/**
 * Fetches cmux's topology (system.capabilities gate, system.tree,
 * extension.sidebar.snapshot) and maps it to the /state response shape,
 * joined against the hook session stores for agent status
 */
export async function getState(
  socketPath: string,
  opts: { password?: string | null; stateDir?: string } = {},
): Promise<StateResponse> {
  const stateDir = opts.stateDir ?? defaultStateDir()
  const reqOpts = { password: opts.password }

  try {
    const capabilities = obj(await request(socketPath, 'system.capabilities', {}, undefined, reqOpts))
    const methods = Array.isArray(capabilities?.methods) ? capabilities.methods.filter((m): m is string => typeof m === 'string') : []
    const missing = REQUIRED_METHODS.filter((m) => !methods.includes(m))
    if (missing.length > 0) {
      return { cmux: false, reason: 'capabilities', message: `cmux is missing required methods: ${missing.join(', ')}` }
    }

    const [tree, sidebar] = await Promise.all([
      request(socketPath, 'system.tree', {}, undefined, reqOpts).then(obj),
      request(socketPath, 'extension.sidebar.snapshot', {}, undefined, reqOpts).then(obj),
    ])
    const hookSessions = await readHookSessions(stateDir)
    const sidebarWorkspaces = sidebarWorkspaceMap(sidebar)
    const { workspaceId: focusedWorkspaceId, surfaceId: focusedPaneId } = findFocusedIds(tree)

    const workspaceRows: WorkspaceRow[] = []
    const agentRows: AgentRow[] = []

    const windows = tree && Array.isArray(tree.windows) ? tree.windows : []
    for (const windowRaw of windows) {
      const window = obj(windowRaw)
      const workspaces = window && Array.isArray(window.workspaces) ? window.workspaces : []

      for (const workspaceRaw of workspaces) {
        const workspace = obj(workspaceRaw)
        if (!workspace) continue

        const workspaceId = str(workspace.id) ?? ''
        workspaceRows.push(toWorkspaceRow(workspace))

        const sidebarWorkspace = sidebarWorkspaces.get(workspaceId) ?? null
        if (isRemoteWorkspace(sidebarWorkspace)) continue

        const branch = workspaceBranch(sidebarWorkspace)
        const workspaceCwd = sidebarWorkspace ? str(sidebarWorkspace.current_directory) : null

        for (const surface of workspaceSurfaces(workspace)) {
          if (surface.type !== 'terminal') continue

          const surfaceId = str(surface.id) ?? ''
          agentRows.push(
            toAgentRow(surface, {
              workspaceId,
              branch,
              workspaceCwd,
              hookSession: hookSessions.get(surfaceId) ?? null,
            }),
          )
        }
      }
    }

    return {
      cmux: true,
      version: str(capabilities?.version) ?? '',
      workspaceId: focusedWorkspaceId,
      paneId: focusedPaneId,
      workspaces: workspaceRows,
      agents: agentRows,
      screenshot: 'available',
    }
  } catch (err) {
    if (err instanceof CmuxError) {
      return { cmux: false, reason: err.code, message: err.message }
    }
    throw err
  }
}

/** Writes an attachment markdown file under dir, returning its absolute path */
export async function writeAttachment(content: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${Date.now()}-${randomBytes(3).toString('hex')}.md`)
  await writeFile(filePath, content, 'utf8')
  return filePath
}

/**
 * Deletes attachment .md and screenshot .png files older than maxAgeMs;
 * ignores a missing directory and per-file errors
 */
export async function cleanupAttachments(dir: string, maxAgeMs = 86400000): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }

  const now = Date.now()
  await Promise.all(
    entries
      .filter((name) => name.endsWith('.md') || name.endsWith('.png'))
      .map(async (name) => {
        const filePath = join(dir, name)
        try {
          const info = await stat(filePath)
          if (now - info.mtimeMs > maxAgeMs) {
            await unlink(filePath)
          }
        } catch {
          // ignore per-file errors
        }
      }),
  )
}

/**
 * Composes the prompt for a validated request and sends it to cmux via
 * terminal.paste, writing an attachment file when the rendered snippet is
 * too large to inline and, when a screenshot PNG was provided, writing it to
 * disk first; a screenshot write failure is logged and the prompt still goes
 * out without it. The request only carries the target surface id, so the
 * surface's workspace id is looked up from a fresh system.tree rather than
 * guessed.
 */
export async function postPrompt(
  body: PromptRequest,
  opts: {
    socketPath: string
    password?: string | null
    inlineMaxChars: number
    roots: string[]
    attachmentDir: string
  },
): Promise<PromptResponse> {
  const el: ElementInfo = { ...body.element, hint: absolutizeHint(body.element.hint, opts.roots) }
  const extras: ElementInfo[] = (body.extras ?? []).map((extra) => ({ ...extra, hint: absolutizeHint(extra.hint, opts.roots) }))

  let screenshotPath: string | undefined
  if (body.screenshotPng !== undefined) {
    const file = join(opts.attachmentDir, `${Date.now()}-${randomBytes(3).toString('hex')}.png`)
    try {
      await mkdir(opts.attachmentDir, { recursive: true })
      await writeFile(file, Buffer.from(body.screenshotPng, 'base64'))
      screenshotPath = file
    } catch (err) {
      console.warn(`[cmux-picker] screenshot failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const attachment = renderAttachment(el, extras)

  const text =
    attachment.length > opts.inlineMaxChars
      ? composePrompt(el, body.prompt, { attachmentPath: await writeAttachment(attachment, opts.attachmentDir), screenshotPath })
      : composePrompt(el, body.prompt, { extras, screenshotPath })

  const reqOpts = { password: opts.password }
  const tree = obj(await request(opts.socketPath, 'system.tree', {}, undefined, reqOpts))
  const context = findSurfaceContext(tree, body.target)
  if (!context) {
    throw new CmuxError('surface_unavailable', `no cmux surface found for target ${body.target}`)
  }

  const result = obj(
    await request(
      opts.socketPath,
      'terminal.paste',
      { workspace_id: context.workspaceId, surface_id: body.target, text, submit_key: 'return' },
      undefined,
      reqOpts,
    ),
  )
  const submitted = Boolean(result?.submitted)

  return {
    ok: true,
    target: body.target,
    title: context.title,
    pane_id: body.target,
    screenshot: screenshotPath ?? null,
    submitted,
    submit_error: submitted ? null : (result ? str(result.submit_error) : null),
  }
}

/** git argv for the two worktree-branch decisions, run via the injectable git runner */
type GitRunner = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>

const execFileAsync = promisify(execFile)

/** Real git runner: `git <args>` run in cwd */
const runGit: GitRunner = (args, cwd) => execFileAsync('git', args, { cwd })

/** Default poll interval/timeout waiting for cmux's hook to bind a session to the new surface */
const DEFAULT_POLL_INTERVAL_MS = 500
const DEFAULT_POLL_TIMEOUT_MS = 60000

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/**
 * Polls the hook session stores every intervalMs until the given surface id
 * shows up in activeSessionsBySurface (via readHookSessions), or throws
 * CmuxError('agent_not_ready', ...) after timeoutMs
 */
async function waitForHookSession(
  stateDir: string,
  surfaceId: string,
  opts: { intervalMs: number; timeoutMs: number },
): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs

  while (true) {
    const sessions = await readHookSessions(stateDir)
    if (sessions.has(surfaceId)) return

    if (Date.now() >= deadline) {
      throw new CmuxError('agent_not_ready', `no cmux hook session bound to surface ${surfaceId} within ${opts.timeoutMs}ms`)
    }

    await sleep(opts.intervalMs)
  }
}

/**
 * Spawns a new agent: mode "here" splits the focused surface next to it,
 * mode "worktree" runs `git worktree add` next to the focused workspace's
 * project root and opens it as a new workspace. Both then run `claude` and
 * wait for cmux's hook to bind a session to the new surface before returning.
 */
export async function spawnAgent(
  body: SpawnRequest,
  opts: {
    socketPath: string
    password?: string | null
    stateDir?: string
    git?: GitRunner
    pollIntervalMs?: number
    pollTimeoutMs?: number
  },
): Promise<SpawnResponse> {
  const reqOpts = { password: opts.password }
  const stateDir = opts.stateDir ?? defaultStateDir()
  const git = opts.git ?? runGit
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const name = body.name ?? `pick-${randomBytes(2).toString('hex')}`

  const [tree, sidebar] = await Promise.all([
    request(opts.socketPath, 'system.tree', {}, undefined, reqOpts).then(obj),
    request(opts.socketPath, 'extension.sidebar.snapshot', {}, undefined, reqOpts).then(obj),
  ])
  const { workspaceId: focusedWorkspaceId, surfaceId: focusedSurfaceId } = findFocusedIds(tree)

  let newSurfaceId: string
  let newWorkspaceId: string | null

  if (body.mode === 'here') {
    if (!focusedWorkspaceId || !focusedSurfaceId) {
      throw new CmuxError('surface_unavailable', 'no focused cmux surface to split next to')
    }

    const splitResult = obj(
      await request(
        opts.socketPath,
        'surface.split',
        { direction: 'right', surface_id: focusedSurfaceId, workspace_id: focusedWorkspaceId, initial_input: 'claude\r', focus: false },
        undefined,
        reqOpts,
      ),
    )
    const splitSurfaceId = splitResult ? str(splitResult.surface_id) : null
    if (!splitSurfaceId) throw new CmuxError('bad_response', 'surface.split did not return a surface id')

    newSurfaceId = splitSurfaceId
    newWorkspaceId = focusedWorkspaceId
  } else {
    if (!focusedWorkspaceId) {
      throw new CmuxError('surface_unavailable', 'no focused cmux workspace to create a worktree from')
    }

    const root = workspaceRoot(sidebarWorkspaceMap(sidebar).get(focusedWorkspaceId) ?? null)
    if (!root) throw new CmuxError('surface_unavailable', 'no project root for the focused cmux workspace')

    const path = join(dirname(root), `${basename(root)}-${name}`)
    const branch = body.branch ?? name

    const branchExists = await git(['rev-parse', '--verify', branch], root).then(
      () => true,
      () => false,
    )

    await git(branchExists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path], root)

    const createResult = obj(
      await request(
        opts.socketPath,
        'workspace.create',
        { title: name, cwd: path, initial_input: 'claude\r', focus: false },
        undefined,
        reqOpts,
      ),
    )
    const createSurfaceId = createResult ? str(createResult.surface_id) : null
    if (!createSurfaceId) throw new CmuxError('bad_response', 'workspace.create did not return a surface id')

    newSurfaceId = createSurfaceId
    newWorkspaceId = createResult ? str(createResult.workspace_id) : null
  }

  await waitForHookSession(stateDir, newSurfaceId, { intervalMs: pollIntervalMs, timeoutMs: pollTimeoutMs })

  return { ok: true, pane_id: newSurfaceId, name, workspace_id: newWorkspaceId }
}
