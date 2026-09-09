import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
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

/** Maps a raw cmux AgentInfo object to the AgentRow shape sent to the client */
export function toAgentRow(a: Record<string, unknown>): AgentRow {
  const tokens = obj(a.tokens)
  const agentSession = obj(a.agent_session)

  return {
    pane_id: str(a.pane_id) ?? '',
    workspace_id: str(a.workspace_id) ?? '',
    agent_status: (str(a.agent_status) ?? 'unknown') as AgentStatus,
    agent: str(a.agent),
    title: str(a.terminal_title_stripped),
    branch: stripBranchIcon(tokens ? str(tokens.branch) : null),
    session: agentSession ? str(agentSession.value) : null,
    focused: Boolean(a.focused),
    cwd: str(a.cwd),
  }
}

/** Maps a raw cmux workspace object to the WorkspaceRow shape sent to the client */
export function toWorkspaceRow(w: Record<string, unknown>): WorkspaceRow {
  return {
    workspace_id: str(w.workspace_id) ?? '',
    label: str(w.label),
    number: typeof w.number === 'number' && Number.isFinite(w.number) ? w.number : null,
    focused: Boolean(w.focused),
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

/** Fetches the cmux session snapshot and maps it to the /state response shape */
export async function getState(socketPath: string, env: NodeJS.ProcessEnv = process.env): Promise<StateResponse> {
  try {
    const top = obj(await request(socketPath, 'session.snapshot', {}))
    const snapshot = top ? obj(top.snapshot) : null

    const protocol = Number(snapshot?.protocol)
    if (!(protocol >= 20)) {
      return { cmux: false, reason: 'protocol', message: `cmux protocol ${protocol} is older than 20` }
    }

    const workspaces = Array.isArray(snapshot?.workspaces) ? snapshot.workspaces : []
    const agents = Array.isArray(snapshot?.agents) ? snapshot.agents : []

    return {
      cmux: true,
      version: str(snapshot?.version) ?? '',
      protocol,
      workspaceId: env.CMUX_WORKSPACE_ID ?? null,
      paneId: env.CMUX_PANE_ID ?? null,
      workspaces: workspaces.map((w) => toWorkspaceRow(obj(w) ?? {})),
      agents: agents.map((a) => toAgentRow(obj(a) ?? {})),
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
 * Composes the prompt for a validated request and sends it to cmux,
 * writing an attachment file when the rendered snippet is too large to inline
 * and, when a screenshot PNG was provided, writing it to disk first; a
 * screenshot write failure is logged and the prompt still goes out without it
 */
export async function postPrompt(
  body: PromptRequest,
  opts: {
    socketPath: string
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

  const result = obj(await request(opts.socketPath, 'agent.prompt', { target: body.target, text }))
  const agent = result ? obj(result.agent) : null

  return {
    ok: true,
    target: body.target,
    title: agent ? str(agent.terminal_title_stripped) : null,
    pane_id: agent ? str(agent.pane_id) : null,
    screenshot: screenshotPath ?? null,
  }
}

/** Default request timeout for agent.start: it waits for the agent to become ready */
const AGENT_START_TIMEOUT_MS = 70000

/**
 * Spawns a new agent: mode "here" splits the focused pane next to it, mode
 * "worktree" creates a new worktree pane, then starts a claude agent in it
 */
export async function spawnAgent(
  body: SpawnRequest,
  opts: { socketPath: string; root: string; env?: NodeJS.ProcessEnv },
): Promise<SpawnResponse> {
  const env = opts.env ?? process.env
  const name = body.name ?? `pick-${randomBytes(2).toString('hex')}`

  let paneId: string
  let workspaceId: string | null

  if (body.mode === 'here') {
    const currentPaneId = env.CMUX_PANE_ID
    if (!currentPaneId) {
      throw new CmuxError('not_in_cmux', 'no focused cmux pane to split next to')
    }

    const splitResult = obj(
      await request(opts.socketPath, 'pane.split', {
        direction: 'right',
        target_pane_id: currentPaneId,
        cwd: opts.root,
        focus: false,
      }),
    )
    const pane = splitResult ? obj(splitResult.pane) : null
    const newPaneId = pane ? str(pane.pane_id) : null
    if (!newPaneId) throw new CmuxError('bad_response', 'pane.split did not return a pane id')

    paneId = newPaneId
    workspaceId = env.CMUX_WORKSPACE_ID ?? null
  } else {
    const worktreeResult = obj(
      await request(opts.socketPath, 'worktree.create', {
        workspace_id: env.CMUX_WORKSPACE_ID ?? null,
        branch: body.branch ?? null,
        focus: false,
      }),
    )
    const rootPane = worktreeResult ? obj(worktreeResult.root_pane) : null
    const workspace = worktreeResult ? obj(worktreeResult.workspace) : null
    const newPaneId = rootPane ? str(rootPane.pane_id) : null
    if (!newPaneId) throw new CmuxError('bad_response', 'worktree.create did not return a pane id')

    paneId = newPaneId
    workspaceId = workspace ? str(workspace.workspace_id) : null
  }

  await request(
    opts.socketPath,
    'agent.start',
    { name, kind: 'claude', pane_id: paneId, timeout_ms: 60000 },
    AGENT_START_TIMEOUT_MS,
  )

  return { ok: true, pane_id: paneId, name, workspace_id: workspaceId }
}

