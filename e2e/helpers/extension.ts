import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserContext, Page } from '@playwright/test'
import { chromium, expect } from '@playwright/test'
import { extensionIdFromKey, hostManifest, wrapperScript } from '../../src/cli.ts'
import { HOST_NAME } from '../../src/host-name.ts'
import type { FakeCmux } from '../../src/__tests__/helpers/fake-cmux.ts'
import { startFakeCmux } from '../../src/__tests__/helpers/fake-cmux.ts'

const EXTENSION_ID = extensionIdFromKey(
  (JSON.parse(readFileSync(fileURLToPath(new URL('../../extension/manifest.json', import.meta.url)), 'utf8')) as { key: string }).key,
)

/** Methods getState gates on, mirrored from bridge.ts's (unexported) REQUIRED_METHODS */
const REQUIRED_METHODS = ['terminal.paste', 'system.tree', 'extension.sidebar.snapshot', 'surface.split', 'workspace.create']

export interface RawReceived {
  method: string
  params: Record<string, unknown>
}

export interface SentPrompt {
  workspace_id: string
  surface_id: string
  submit_key: string
  text: string
}

export interface Harness {
  context: BrowserContext
  page: Page
  fake: FakeCmux
  sentPrompts(): SentPrompt[]
  raw(): RawReceived[]
  close(): Promise<void>
}

const FIXTURE_HTML = `<!doctype html><html><head><title>pick</title><style>body{margin:40px;font:16px sans-serif}.btn{padding:8px 16px;background:#6e56cf;color:#fff;border:0;border-radius:6px}</style></head><body><main><h1>Settings</h1><form class="settings"><label>Name <input id="name" value="Marco"></label><p class="note"><span class="note-text">Saved locally</span></p><button id="save" class="btn btn-primary" type="button">Save</button></form></main></body></html>`

// --- system.tree / extension.sidebar.snapshot fixtures ---------------------

export interface TerminalSurfaceFixture {
  id: string
  title: string
  focused?: boolean
}

export interface WorkspaceFixture {
  id: string
  title: string
  index: number
  selected?: boolean
  currentDirectory: string
  branch?: string | null
  surfaces: TerminalSurfaceFixture[]
}

/**
 * Builds a system.tree result: one window holding the given workspaces. Real
 * cmux nests surfaces two levels down (workspace.panes[].surfaces[], not
 * workspace.surfaces), has no `focused` key on a workspace node (only
 * `selected`), and carries the true focus pointer at the top level in
 * `active` - all mirrored here so the e2e exercises the real shape.
 */
function buildTree(workspaces: WorkspaceFixture[]): unknown {
  const selectedWorkspace = workspaces.find((w) => w.selected) ?? workspaces[0] ?? null
  const focusedSurface = selectedWorkspace?.surfaces.find((s) => s.focused) ?? selectedWorkspace?.surfaces[0] ?? null

  return {
    active: selectedWorkspace ? { workspace_id: selectedWorkspace.id, surface_id: focusedSurface?.id ?? null } : null,
    windows: [
      {
        id: 'win1',
        index: 0,
        selected_workspace_id: selectedWorkspace?.id ?? null,
        workspaces: workspaces.map((w) => ({
          id: w.id,
          index: w.index,
          title: w.title,
          selected: w.selected ?? false,
          panes: [
            { surfaces: w.surfaces.map((s, i) => ({ id: s.id, index: i, type: 'terminal', title: s.title, focused: s.focused ?? false, selected: false })) },
          ],
        })),
      },
    ],
  }
}

/**
 * Builds an extension.sidebar.snapshot result matching the given workspaces.
 * Keyed by `id` (not `workspace_id`), branch comes through `branch_summary`,
 * and `remote_connection_state` is deliberately "disconnected" even though
 * every fixture workspace is local (remote.enabled: false) - that combination
 * is what real cmux reports for a local workspace, and is what getState must
 * not read as remote (see bridge.ts's isRemoteWorkspace).
 */
function buildSidebar(workspaces: WorkspaceFixture[]): unknown {
  return {
    selected_workspace_id: workspaces.find((w) => w.selected)?.id ?? workspaces[0]?.id ?? null,
    sequence: 1,
    window_id: 'win1',
    workspaces: workspaces.map((w) => ({
      id: w.id,
      title: w.title,
      index: w.index,
      current_directory: w.currentDirectory,
      root_path: w.currentDirectory,
      project_root_path: w.currentDirectory,
      branch_summary: w.branch ?? null,
      git_branches: [],
      is_dirty: false,
      is_pinned: false,
      is_selected: w.selected ?? false,
      remote: { enabled: false, destination: null },
      remote_connection_state: 'disconnected',
      listening_ports: [],
    })),
  }
}

export const DEFAULT_WORKSPACE_ID = 'w1'
export const DEFAULT_SURFACE_ID = 'sf1'
export const DEFAULT_SESSION_ID = 'sess1'

const DEFAULT_WORKSPACES: WorkspaceFixture[] = [
  {
    id: DEFAULT_WORKSPACE_ID,
    title: 'app',
    index: 0,
    selected: true,
    currentDirectory: '/tmp/proj',
    branch: 'main',
    surfaces: [{ id: DEFAULT_SURFACE_ID, title: 'Settings polish', focused: false }],
  },
]

// --- ~/.cmuxterm/<agent>-hook-sessions.json fixtures ------------------------

export interface HookSessionFixture {
  /** Filename stem: written to <stateDir>/<agent>-hook-sessions.json */
  agent: string
  sessionId: string
  workspaceId: string
  surfaceId: string
  cwd: string
  title: string
  lifecycle: string
}

/**
 * Writes one hook-sessions.json store per distinct agent among entries,
 * replacing any existing file for that agent. Real cmux writes just
 * {version, sessions}, each session carrying its own surfaceId and a numeric
 * (unix seconds) updatedAt - no activeSessionsBySurface index - so
 * readHookSessions must fold sessions by surfaceId itself.
 */
function writeHookStores(stateDir: string, entries: HookSessionFixture[]): void {
  const byAgent = new Map<string, HookSessionFixture[]>()
  for (const entry of entries) {
    const list = byAgent.get(entry.agent) ?? []
    list.push(entry)
    byAgent.set(entry.agent, list)
  }

  for (const [agent, agentEntries] of byAgent) {
    const now = Date.now() / 1000
    const sessions: Record<string, unknown> = {}

    for (const entry of agentEntries) {
      sessions[entry.sessionId] = {
        sessionId: entry.sessionId,
        workspaceId: entry.workspaceId,
        surfaceId: entry.surfaceId,
        cwd: entry.cwd,
        title: entry.title,
        transcriptPath: null,
        pid: 4242,
        agentLifecycle: entry.lifecycle,
        startedAt: now,
        updatedAt: now,
      }
    }

    const store = { version: 1, sessions }
    writeFileSync(join(stateDir, `${agent}-hook-sessions.json`), JSON.stringify(store), 'utf8')
  }
}

function defaultHookSession(lifecycle: string): HookSessionFixture {
  return {
    agent: 'claude',
    sessionId: DEFAULT_SESSION_ID,
    workspaceId: DEFAULT_WORKSPACE_ID,
    surfaceId: DEFAULT_SURFACE_ID,
    cwd: '/tmp/proj',
    title: 'Settings polish',
    lifecycle,
  }
}

/**
 * Default terminal.paste handler: mirrors cmux's real behaviour where the agent's
 * lifecycle only flips to "running" once Claude Code's prompt-submit hook runs,
 * asynchronously, then back to "idle" once it finishes - both by rewriting the
 * hook store file the host polls, not by replying differently. Targets whichever
 * workspace/surface the request actually named (not the default fixture's ids),
 * so it still drives the DONE transition when a test supplies its own workspaces.
 */
function defaultTerminalPasteHandler(stateDir: string): (params: Record<string, unknown>) => unknown {
  return (params) => {
    const workspaceId = String(params.workspace_id ?? DEFAULT_WORKSPACE_ID)
    const surfaceId = String(params.surface_id ?? DEFAULT_SURFACE_ID)
    const session = (lifecycle: string): HookSessionFixture => ({
      agent: 'claude',
      sessionId: DEFAULT_SESSION_ID,
      workspaceId,
      surfaceId,
      cwd: '/tmp/proj',
      title: 'Settings polish',
      lifecycle,
    })

    try {
      writeHookStores(stateDir, [session('running')])
    } catch {
      // best effort: a poll will just see the previous status this tick
    }
    setTimeout(() => {
      try {
        writeHookStores(stateDir, [session('idle')])
      } catch {
        // test may have already torn its state dir down
      }
    }, 3000)
    return { workspace_id: params.workspace_id, surface_id: params.surface_id, submitted: true, terminal_seq: 1 }
  }
}

// --- harness -----------------------------------------------------------------

export async function launchExtension(opts: {
  /** Override or add fake-cmux method handlers (e.g. system.tree, extension.sidebar.snapshot, terminal.paste, surface.split, workspace.create) */
  handlers?: Record<string, (params: Record<string, unknown>) => unknown>
  /** Workspaces/surfaces behind the default system.tree and extension.sidebar.snapshot handlers */
  workspaces?: WorkspaceFixture[]
  /** Initial ~/.cmuxterm/<agent>-hook-sessions.json content; default: one idle claude session on the default surface */
  hookSessions?: HookSessionFixture[]
  installHost?: boolean
  html?: string
}): Promise<Harness> {
  // Assert that the extension is built
  const dist = fileURLToPath(new URL('../../dist/', import.meta.url))
  const extensionDist = join(dist, 'extension')
  const manifestPath = join(extensionDist, 'manifest.json')
  const hostJsPath = join(dist, 'host.js')

  if (!existsSync(manifestPath)) {
    throw new Error('run npm run build before the e2e')
  }
  if (!existsSync(hostJsPath)) {
    throw new Error('run npm run build before the e2e')
  }

  // Setup temp dir, profile and the cmux hook-session state dir
  const tempDir = tmpdir()
  const testDir = `${tempDir}/cmux-picker-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  mkdirSync(testDir, { recursive: true })

  const userDataDir = join(testDir, 'profile')
  mkdirSync(userDataDir, { recursive: true })

  const stateDir = join(testDir, 'state')
  mkdirSync(stateDir, { recursive: true })
  writeHookStores(stateDir, opts.hookSessions ?? [defaultHookSession('idle')])

  const workspaces = opts.workspaces ?? DEFAULT_WORKSPACES

  // Start fake cmux
  const fake = await startFakeCmux({
    'system.capabilities': () => ({ methods: REQUIRED_METHODS, version: 'fake-cmux-1.0' }),
    'system.tree': () => buildTree(workspaces),
    'extension.sidebar.snapshot': () => buildSidebar(workspaces),
    'terminal.paste': defaultTerminalPasteHandler(stateDir),
    ...opts.handlers,
  })

  // Copy and patch extension
  const extDir = join(testDir, 'ext')
  cpSync(extensionDist, extDir, { recursive: true })

  // Patch manifest to add host_permissions
  const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'))
  manifest.host_permissions = ['<all_urls>']
  writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest))

  // Setup native host if requested
  if (opts.installHost !== false) {
    const hostShPath = join(testDir, 'host.sh')
    const wrapper = wrapperScript({
      nodePath: process.execPath,
      hostJs: hostJsPath,
      socketPath: fake.socketPath,
    })
    // wrapperScript (src/cli.ts) has no CMUX_PICKER_STATE_DIR knob; splice the export
    // into the generated wrapper here rather than growing the shared CLI helper for tests.
    const lines = wrapper.split('\n')
    const execIdx = lines.findIndex((line) => line.startsWith('exec '))
    const stateDirExport = `export CMUX_PICKER_STATE_DIR="${stateDir.replace(/"/g, '\\"')}"`
    const wrapperWithStateDir = (execIdx === -1 ? [...lines, stateDirExport] : [...lines.slice(0, execIdx), stateDirExport, ...lines.slice(execIdx)]).join('\n')
    writeFileSync(hostShPath, wrapperWithStateDir, 'utf8')
    chmodSync(hostShPath, 0o755)

    const nativeMessagingHostsDir = join(userDataDir, 'NativeMessagingHosts')
    mkdirSync(nativeMessagingHostsDir, { recursive: true })

    const manifestJson = hostManifest({ hostScript: hostShPath, extensionId: EXTENSION_ID })
    writeFileSync(
      join(nativeMessagingHostsDir, `${HOST_NAME}.json`),
      JSON.stringify(manifestJson),
      'utf8',
    )
  }

  // Launch browser
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  })

  // Setup route for test page
  await context.route('http://127.0.0.1/**', (route) => {
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: opts.html ?? FIXTURE_HTML,
    })
  })

  // Create page and navigate
  const page = await context.newPage()
  await page.goto('http://127.0.0.1/pick.html')

  // Return harness
  return {
    context,
    page,
    fake,
    sentPrompts() {
      return fake.received
        .filter((msg) => msg.method === 'terminal.paste')
        .map((msg) => ({
          workspace_id: String(msg.params.workspace_id ?? ''),
          surface_id: String(msg.params.surface_id ?? ''),
          submit_key: String(msg.params.submit_key ?? ''),
          text: String(msg.params.text ?? ''),
        }))
    },
    raw() {
      return fake.received
    },
    async close() {
      await context.close()
      await fake.close()
      // Clean up temp dir
      const fs = await import('node:fs/promises')
      await fs.rm(testDir, { recursive: true, force: true })
    },
  }
}

export async function triggerPick(context: BrowserContext, page: Page): Promise<void> {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))

  const tabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1/*' })
    return tabs[0]?.id
  })

  if (tabId === undefined) {
    throw new Error('Could not find tab with test URL')
  }

  await sw.evaluate((id) => {
    return (globalThis as unknown as { __cmuxPick(id: number): Promise<void> }).__cmuxPick(id)
  }, tabId)

  await expect(page.locator('[data-cmux-host]')).toBeAttached()
}

export async function pickSaveButton(page: Page): Promise<void> {
  const saveButton = page.locator('#save')
  const boundingBox = await saveButton.boundingBox()

  if (!boundingBox) {
    throw new Error('Save button not found or not visible')
  }

  const centerX = boundingBox.x + boundingBox.width / 2
  const centerY = boundingBox.y + boundingBox.height / 2

  await page.mouse.move(centerX, centerY)
  await page.mouse.click(centerX, centerY)

  await expect(page.locator('[data-cmux-host] .popup')).toBeVisible()
}
