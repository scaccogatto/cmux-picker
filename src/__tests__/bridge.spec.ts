import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, mkdir, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { CmuxError } from '../cmux.ts'
import {
  absolutizeHint,
  cleanupAttachments,
  getState,
  postPrompt,
  readHookSessions,
  spawnAgent,
  toAgentRow,
  toWorkspaceRow,
  writeAttachment,
} from '../bridge.ts'
import { startFakeCmux } from './helpers/fake-cmux.ts'
import type { FakeCmux } from './helpers/fake-cmux.ts'

const CAPABILITIES = {
  methods: ['terminal.paste', 'system.tree', 'extension.sidebar.snapshot', 'surface.split', 'workspace.create', 'surface.send_text', 'surface.send_key'],
  version: '0.64.22',
}

/**
 * Writes stateDir/<agent>-hook-sessions.json in the real shape: just
 * {version, sessions}, one session carrying its own surfaceId. No
 * activeSessionsBySurface - readHookSessions must fold sessions itself.
 */
async function writeHookStore(
  stateDir: string,
  agent: string,
  opts: { surfaceId: string; sessionId: string; lifecycle?: string; cwd?: string; updatedAt?: number },
): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  const store = {
    version: 1,
    sessions: {
      [opts.sessionId]: {
        sessionId: opts.sessionId,
        surfaceId: opts.surfaceId,
        agentLifecycle: opts.lifecycle,
        cwd: opts.cwd,
        updatedAt: opts.updatedAt ?? 1,
      },
    },
  }
  await writeFile(join(stateDir, `${agent}-hook-sessions.json`), JSON.stringify(store), 'utf8')
}

// --- system.tree / extension.sidebar.snapshot builders ---------------------
// Real cmux nests surfaces two levels under a workspace: panes[].surfaces[],
// not workspace.surfaces directly (see src/__tests__/fixtures/cmux/system.tree.json).

/** A system.tree pane node holding the given surfaces */
function pane(surfaces: Record<string, unknown>[]): Record<string, unknown> {
  return { surfaces }
}

/** A system.tree surface node; a workspace node has no `focused` key, only a surface does */
function surfaceNode(
  id: string,
  opts: { type?: string; title?: string | null; focused?: boolean; selected?: boolean } = {},
): Record<string, unknown> {
  return {
    id,
    type: opts.type ?? 'terminal',
    title: opts.title ?? null,
    focused: opts.focused ?? false,
    selected: opts.selected ?? false,
  }
}

/**
 * A system.tree result: one window holding the given workspaces (each
 * already carrying `panes`). `active` defaults to null, matching the real
 * "no cmux window is key" state, so most tests exercise the
 * selected_workspace_id fallback in findFocusedIds unless they opt in.
 */
function treeWith(workspaces: Record<string, unknown>[], opts: { active?: unknown } = {}): unknown {
  const selected = workspaces.find((w) => w.selected === true) ?? workspaces[0]
  return {
    active: 'active' in opts ? opts.active : null,
    windows: [{ id: 'win1', index: 0, selected_workspace_id: selected ? (selected.id ?? null) : null, workspaces }],
  }
}

/** An extension.sidebar.snapshot workspace entry, keyed by `id` (not `workspace_id`) */
function sidebarWorkspace(
  id: string,
  opts: {
    currentDirectory?: string | null
    projectRootPath?: string | null
    rootPath?: string | null
    branchSummary?: string | null
    gitBranches?: { branch: string; dirty: boolean }[]
    remote?: { enabled?: boolean; destination?: string | null }
    remoteConnectionState?: string | null
  } = {},
): Record<string, unknown> {
  return {
    id,
    current_directory: opts.currentDirectory ?? null,
    project_root_path: opts.projectRootPath ?? null,
    root_path: opts.rootPath ?? null,
    branch_summary: opts.branchSummary ?? null,
    git_branches: opts.gitBranches ?? [],
    remote: { enabled: opts.remote?.enabled ?? false, destination: opts.remote?.destination ?? null },
    remote_connection_state: opts.remoteConnectionState ?? null,
  }
}

describe('toAgentRow', () => {
  const surface = { id: 's1', type: 'terminal', title: 'Profilo LinkedIn', focused: false }

  it('maps a full surface with a bound hook session', () => {
    expect(
      toAgentRow(surface, {
        workspaceId: 'w1',
        branch: 'main',
        workspaceCwd: '/x',
        hookSession: { sessionId: 'sess1', lifecycle: 'running', cwd: '/y', updatedAt: null, agent: 'claude' },
      }),
    ).toEqual({
      pane_id: 's1',
      workspace_id: 'w1',
      agent_status: 'working',
      agent: 'claude',
      title: 'Profilo LinkedIn',
      branch: 'main',
      session: 'sess1',
      focused: false,
      cwd: '/y',
    })
  })

  it('falls back to workspace cwd and unknown status when there is no hook session', () => {
    expect(toAgentRow(surface, { workspaceId: 'w1', branch: null, workspaceCwd: '/workspace', hookSession: null })).toEqual({
      pane_id: 's1',
      workspace_id: 'w1',
      agent_status: 'unknown',
      agent: null,
      title: 'Profilo LinkedIn',
      branch: null,
      session: null,
      focused: false,
      cwd: '/workspace',
    })
  })

  it.each([
    ['running', 'working'],
    ['idle', 'idle'],
    ['needsInput', 'blocked'],
    ['ended', 'unknown'],
  ])('maps lifecycle %s to agent_status %s', (lifecycle, expected) => {
    const row = toAgentRow(surface, {
      workspaceId: 'w1',
      branch: null,
      workspaceCwd: null,
      hookSession: { sessionId: 's', lifecycle, cwd: null, updatedAt: null, agent: 'claude' },
    })
    expect(row.agent_status).toBe(expected)
  })
})

describe('toWorkspaceRow', () => {
  it('maps id/title/index/selected to workspace_id/label/number/focused', () => {
    expect(toWorkspaceRow({ id: 'w33', title: 'dotfiles', index: 0, selected: false })).toEqual({
      workspace_id: 'w33',
      label: 'dotfiles',
      number: 1,
      focused: false,
    })
  })

  it('falls back missing title to null and missing index to null', () => {
    expect(toWorkspaceRow({ id: 'w33', selected: true })).toEqual({
      workspace_id: 'w33',
      label: null,
      number: null,
      focused: true,
    })
  })
})

describe('absolutizeHint', () => {
  it('absolutizes a relative hint with line:col plus suffix', () => {
    expect(absolutizeHint('src/components/Button.tsx:42:10 (extra)', ['/repo'])).toBe(
      '/repo/src/components/Button.tsx:42:10 (extra)',
    )
  })

  it('leaves an absolute path hint unchanged', () => {
    expect(absolutizeHint('/repo/src/Button.tsx:42:10', ['/repo'])).toBe('/repo/src/Button.tsx:42:10')
  })

  it('leaves a non-matching hint unchanged', () => {
    expect(absolutizeHint('react component X, no file', ['/repo'])).toBe('react component X, no file')
  })

  it('returns null for a null hint', () => {
    expect(absolutizeHint(null, ['/repo'])).toBeNull()
  })

  it('tries each root in order for relative paths', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cmp-test-'))
    mkdirSync(join(tmp, 'demo'))
    writeFileSync(join(tmp, 'demo', 'Bench.vue'), '')

    expect(absolutizeHint('demo/Bench.vue:11:7 (data-v-inspector)', [join(tmp, 'demo'), tmp])).toBe(
      `${join(tmp, 'demo', 'Bench.vue')}:11:7 (data-v-inspector)`,
    )
  })

  it('falls back to the first root when no file exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cmp-test-'))
    mkdirSync(join(tmp, 'demo'))

    expect(absolutizeHint('nope/X.vue:3:4', [join(tmp, 'demo'), tmp])).toBe(
      `${join(tmp, 'demo', 'nope', 'X.vue')}:3:4`,
    )
  })

  it('finds a file in the second root when it does not exist in the first', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cmp-test-'))
    mkdirSync(join(tmp, 'a'))
    mkdirSync(join(tmp, 'b'))
    writeFileSync(join(tmp, 'b', 'file.ts'), '')

    expect(absolutizeHint('file.ts:1:1', [join(tmp, 'a'), join(tmp, 'b')])).toBe(
      `${join(tmp, 'b', 'file.ts')}:1:1`,
    )
  })
})

describe('readHookSessions', () => {
  it('folds sessions by surfaceId and tags the agent from the filename', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))
    await writeHookStore(stateDir, 'claude', { surfaceId: 's1', sessionId: 'sess1', lifecycle: 'running', cwd: '/proj', updatedAt: 100 })

    const sessions = await readHookSessions(stateDir)
    expect(sessions.get('s1')).toEqual({ sessionId: 'sess1', lifecycle: 'running', cwd: '/proj', updatedAt: 100, agent: 'claude' })
  })

  it('returns an empty map for a missing state directory', async () => {
    const sessions = await readHookSessions('/nonexistent/state/dir')
    expect(sessions.size).toBe(0)
  })

  it('keeps the last good snapshot when a later read hits a half-written file', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))
    const storePath = join(stateDir, 'claude-hook-sessions.json')
    await writeHookStore(stateDir, 'claude', { surfaceId: 's1', sessionId: 'sess1', lifecycle: 'idle' })

    const first = await readHookSessions(stateDir)
    expect(first.get('s1')?.lifecycle).toBe('idle')

    // Simulate a hook process caught mid-write: truncated, invalid JSON
    await writeFile(storePath, '{"sessions": {"sess1": {"agentLife', 'utf8')

    const second = await readHookSessions(stateDir)
    expect(second.get('s1')?.lifecycle).toBe('idle')
  })

  it('merges sessions from multiple agent store files', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))
    await writeHookStore(stateDir, 'claude', { surfaceId: 's1', sessionId: 'sess1', lifecycle: 'running' })
    await writeHookStore(stateDir, 'codex', { surfaceId: 's2', sessionId: 'sess2', lifecycle: 'needsInput' })

    const sessions = await readHookSessions(stateDir)
    expect(sessions.get('s1')?.agent).toBe('claude')
    expect(sessions.get('s2')?.agent).toBe('codex')
  })

  it('keeps the newer updatedAt when two sessions bind the same surface', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))
    await mkdir(stateDir, { recursive: true })
    const store = {
      version: 1,
      sessions: {
        old: { sessionId: 'old', surfaceId: 's1', agentLifecycle: 'idle', updatedAt: 100 },
        recent: { sessionId: 'recent', surfaceId: 's1', agentLifecycle: 'running', updatedAt: 200 },
      },
    }
    await writeFile(join(stateDir, 'claude-hook-sessions.json'), JSON.stringify(store), 'utf8')

    const sessions = await readHookSessions(stateDir)
    expect(sessions.get('s1')).toMatchObject({ sessionId: 'recent', lifecycle: 'running', updatedAt: 200 })
  })

  it('prefers a non-empty activeSessionsBySurface index over folding sessions itself', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))
    await mkdir(stateDir, { recursive: true })
    const store = {
      version: 1,
      // Folding by greatest updatedAt alone would pick "higherUpdatedAt" (500);
      // the active index deliberately names the other session, to prove the
      // index is what actually gets used when present.
      sessions: {
        higherUpdatedAt: { sessionId: 'higherUpdatedAt', surfaceId: 's1', agentLifecycle: 'idle', updatedAt: 500 },
        namedByIndex: { sessionId: 'namedByIndex', surfaceId: 's1', agentLifecycle: 'running', updatedAt: 100 },
      },
      activeSessionsBySurface: { s1: { sessionId: 'namedByIndex' } },
    }
    await writeFile(join(stateDir, 'claude-hook-sessions.json'), JSON.stringify(store), 'utf8')

    const sessions = await readHookSessions(stateDir)
    expect(sessions.get('s1')?.sessionId).toBe('namedByIndex')
  })

  it('reads the real ~/.cmuxterm/<agent>-hook-sessions.json shape (no activeSessionsBySurface, numeric updatedAt)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))
    const fixture = readFileSync(new URL('./fixtures/cmux/claude-hook-sessions.json', import.meta.url), 'utf8')
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, 'claude-hook-sessions.json'), fixture, 'utf8')

    const sessions = await readHookSessions(stateDir)
    expect(sessions.get('6D2FEC4E-203A-41FC-B0F1-F7D72F2EBDF5')).toEqual({
      sessionId: '7e4c7f5b-96ce-4b8a-af2c-264aa615a4b3',
      lifecycle: 'unknown',
      cwd: '/Users/dev',
      updatedAt: 1788988738.3728318,
      agent: 'claude',
    })
  })
})

describe('getState', () => {
  let fake: FakeCmux | undefined
  let stateDir: string

  afterEach(async () => {
    await fake?.close()
    fake = undefined
  })

  it('returns cmux:false reason capabilities when a required method is missing', async () => {
    fake = await startFakeCmux({
      'system.capabilities': () => ({ methods: ['terminal.paste', 'system.tree'], version: '0.64.22' }),
    })
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))

    const state = await getState(fake.socketPath, { stateDir })
    expect(state).toMatchObject({ cmux: false, reason: 'capabilities' })
    expect((state as { message: string }).message).toContain('extension.sidebar.snapshot')
  })

  it('returns cmux:false reason access_denied when cmux answers ERROR: on a request', async () => {
    fake = await startFakeCmux({}, { password: 'secret' })
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))

    const state = await getState(fake.socketPath, { stateDir, password: 'wrong' })
    expect(state).toMatchObject({ cmux: false, reason: 'access_denied' })
  })

  it('returns cmux:false reason no_socket when the socket is missing', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))
    const state = await getState('/nonexistent/dir/cmux.sock', { stateDir })
    expect(state).toMatchObject({ cmux: false, reason: 'no_socket' })
  })

  it('maps terminal surfaces nested under panes to agent rows, resolving focus from tree.active', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))
    await writeHookStore(stateDir, 'claude', { surfaceId: 'surf1', sessionId: 'sess1', lifecycle: 'idle', cwd: '/proj/local' })

    fake = await startFakeCmux({
      'system.capabilities': () => CAPABILITIES,
      'system.tree': () =>
        treeWith(
          [
            {
              id: 'w1',
              index: 0,
              title: 'dotfiles',
              selected: true,
              panes: [
                pane([
                  surfaceNode('surf1', { title: 'Profilo LinkedIn', focused: true }),
                  surfaceNode('surf2', { type: 'browser', title: 'Docs' }),
                ]),
              ],
            },
          ],
          { active: { workspace_id: 'w1', surface_id: 'surf1' } },
        ),
      'extension.sidebar.snapshot': () => ({ workspaces: [sidebarWorkspace('w1', { currentDirectory: '/proj', branchSummary: ' main' })] }),
    })

    const state = await getState(fake.socketPath, { stateDir })

    expect(state).toMatchObject({ cmux: true, workspaceId: 'w1', paneId: 'surf1', screenshot: 'available' })
    if (state.cmux !== true) throw new Error('expected cmux:true')
    expect(state.workspaces).toEqual([{ workspace_id: 'w1', label: 'dotfiles', number: 1, focused: true }])
    expect(state.agents).toEqual([
      { pane_id: 'surf1', workspace_id: 'w1', agent_status: 'idle', agent: 'claude', title: 'Profilo LinkedIn', branch: 'main', session: 'sess1', focused: true, cwd: '/proj/local' },
    ])
  })

  it('falls back to the window selected_workspace_id and a focused-or-selected surface when tree.active is null', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))

    fake = await startFakeCmux({
      'system.capabilities': () => CAPABILITIES,
      'system.tree': () =>
        treeWith(
          [{ id: 'w1', index: 0, title: 'dotfiles', selected: true, panes: [pane([surfaceNode('surf1', { selected: true })])] }],
          { active: null },
        ),
      'extension.sidebar.snapshot': () => ({ workspaces: [sidebarWorkspace('w1', { currentDirectory: '/proj' })] }),
    })

    const state = await getState(fake.socketPath, { stateDir })
    expect(state).toMatchObject({ workspaceId: 'w1', paneId: 'surf1' })
  })

  it('falls back to the workspace surfaces when tree.active names a workspace but no surface', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))

    fake = await startFakeCmux({
      'system.capabilities': () => CAPABILITIES,
      'system.tree': () =>
        treeWith(
          [{ id: 'w1', index: 0, title: 'dotfiles', selected: true, panes: [pane([surfaceNode('surf1', { selected: true })])] }],
          { active: { workspace_id: 'w1', surface_id: null } },
        ),
      'extension.sidebar.snapshot': () => ({ workspaces: [sidebarWorkspace('w1', { currentDirectory: '/proj' })] }),
    })

    const state = await getState(fake.socketPath, { stateDir })
    expect(state).toMatchObject({ workspaceId: 'w1', paneId: 'surf1' })
  })

  it('marks an untracked terminal surface unknown with no hook session', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))

    fake = await startFakeCmux({
      'system.capabilities': () => CAPABILITIES,
      'system.tree': () =>
        treeWith([
          { id: 'w1', index: 0, title: 'dotfiles', selected: true, panes: [pane([surfaceNode('surf1', { title: 'plain shell' })])] },
        ]),
      'extension.sidebar.snapshot': () => ({ workspaces: [sidebarWorkspace('w1', { currentDirectory: '/proj' })] }),
    })

    const state = await getState(fake.socketPath, { stateDir })
    if (state.cmux !== true) throw new Error('expected cmux:true')
    expect(state.agents).toEqual([
      { pane_id: 'surf1', workspace_id: 'w1', agent_status: 'unknown', agent: null, title: 'plain shell', branch: null, session: null, focused: false, cwd: '/proj' },
    ])
  })

  it('walks every pane in a workspace, not just the first, to find terminal surfaces', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))

    fake = await startFakeCmux({
      'system.capabilities': () => CAPABILITIES,
      'system.tree': () =>
        treeWith([
          {
            id: 'w1',
            index: 0,
            title: 'split',
            selected: true,
            panes: [pane([surfaceNode('surf1', { focused: true })]), pane([surfaceNode('surf2')])],
          },
        ]),
      'extension.sidebar.snapshot': () => ({ workspaces: [sidebarWorkspace('w1', { currentDirectory: '/proj' })] }),
    })

    const state = await getState(fake.socketPath, { stateDir })
    if (state.cmux !== true) throw new Error('expected cmux:true')
    expect(state.agents.map((a) => a.pane_id).sort()).toEqual(['surf1', 'surf2'])
  })

  it('filters out a workspace with remote.enabled true, but keeps a local workspace whose remote_connection_state is "disconnected"', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))

    fake = await startFakeCmux({
      'system.capabilities': () => CAPABILITIES,
      'system.tree': () =>
        treeWith([
          { id: 'w1', index: 0, title: 'local', selected: true, panes: [pane([surfaceNode('surf1', { focused: true })])] },
          { id: 'w2', index: 1, title: 'remote box', panes: [pane([surfaceNode('surf2')])] },
        ]),
      'extension.sidebar.snapshot': () => ({
        workspaces: [
          // Real cmux: an ordinary LOCAL workspace still reports remote_connection_state
          // "disconnected" - this is the defect-5 trap, must NOT be read as remote.
          sidebarWorkspace('w1', { currentDirectory: '/proj', remoteConnectionState: 'disconnected', remote: { enabled: false } }),
          sidebarWorkspace('w2', { currentDirectory: '/remote/proj', remoteConnectionState: 'connected', remote: { enabled: true, destination: 'ssh://remote-box' } }),
        ],
      }),
    })

    const state = await getState(fake.socketPath, { stateDir })
    if (state.cmux !== true) throw new Error('expected cmux:true')
    // Both workspaces are still listed...
    expect(state.workspaces.map((w) => w.workspace_id)).toEqual(['w1', 'w2'])
    // ...but only the local workspace's surface becomes an agent row
    expect(state.agents.map((a) => a.pane_id)).toEqual(['surf1'])
  })

  it('derives branch from git_branches[0] when branch_summary is null', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))

    fake = await startFakeCmux({
      'system.capabilities': () => CAPABILITIES,
      'system.tree': () =>
        treeWith([{ id: 'w1', index: 0, title: 'dotfiles', selected: true, panes: [pane([surfaceNode('surf1', { focused: true })])] }]),
      'extension.sidebar.snapshot': () => ({
        workspaces: [sidebarWorkspace('w1', { currentDirectory: '/proj', branchSummary: null, gitBranches: [{ branch: 'feature/x', dirty: true }] })],
      }),
    })

    const state = await getState(fake.socketPath, { stateDir })
    if (state.cmux !== true) throw new Error('expected cmux:true')
    expect(state.agents[0]?.branch).toBe('feature/x')
  })

  it('excludes non-terminal surfaces', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))

    fake = await startFakeCmux({
      'system.capabilities': () => CAPABILITIES,
      'system.tree': () =>
        treeWith([
          { id: 'w1', index: 0, title: 'dotfiles', selected: true, panes: [pane([surfaceNode('surf1', { type: 'browser', title: 'Docs' })])] },
        ]),
      'extension.sidebar.snapshot': () => ({ workspaces: [sidebarWorkspace('w1', { currentDirectory: '/proj' })] }),
    })

    const state = await getState(fake.socketPath, { stateDir })
    if (state.cmux !== true) throw new Error('expected cmux:true')
    expect(state.agents).toEqual([])
  })

  it('reproduces a live cmux 0.64.22 snapshot from the saved system.tree / sidebar / hook-store fixtures', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))
    await mkdir(stateDir, { recursive: true })
    await writeFile(
      join(stateDir, 'claude-hook-sessions.json'),
      readFileSync(new URL('./fixtures/cmux/claude-hook-sessions.json', import.meta.url), 'utf8'),
      'utf8',
    )
    const tree = JSON.parse(readFileSync(new URL('./fixtures/cmux/system.tree.json', import.meta.url), 'utf8')) as unknown
    const sidebar = JSON.parse(readFileSync(new URL('./fixtures/cmux/extension.sidebar.snapshot.json', import.meta.url), 'utf8')) as unknown

    fake = await startFakeCmux({
      'system.capabilities': () => CAPABILITIES,
      'system.tree': () => tree,
      'extension.sidebar.snapshot': () => sidebar,
    })

    const state = await getState(fake.socketPath, { stateDir })

    expect(state).toMatchObject({
      cmux: true,
      workspaceId: 'C079048E-E07E-4D6D-86AB-B15E6C887704',
      paneId: '6D2FEC4E-203A-41FC-B0F1-F7D72F2EBDF5',
    })
    if (state.cmux !== true) throw new Error('expected cmux:true')
    expect(state.workspaces).toEqual([{ workspace_id: 'C079048E-E07E-4D6D-86AB-B15E6C887704', label: '~', number: 1, focused: true }])
    // The fixture's remote_connection_state is "disconnected" with remote.enabled false: local, so its agent must show up.
    expect(state.agents).toEqual([
      {
        pane_id: '6D2FEC4E-203A-41FC-B0F1-F7D72F2EBDF5',
        workspace_id: 'C079048E-E07E-4D6D-86AB-B15E6C887704',
        agent_status: 'unknown',
        agent: 'claude',
        title: '~',
        branch: null,
        session: '7e4c7f5b-96ce-4b8a-af2c-264aa615a4b3',
        focused: true,
        cwd: '/Users/dev',
      },
    ])
  })
})

describe('postPrompt', () => {
  let fake: FakeCmux | undefined

  afterEach(async () => {
    await fake?.close()
    fake = undefined
  })

  const element = {
    url: 'http://localhost:3000/page',
    viewport: { w: 1440, h: 900 },
    hint: 'src/components/Button.tsx:42:10',
    path: 'body > main > button.primary',
    rect: { x: 100, y: 200, w: 320, h: 40 },
    html: '<button class="primary">Click me</button>',
    styles: { display: 'inline-flex' },
  }

  const treeWithSurface = () =>
    treeWith([
      { id: 'w1', index: 0, title: 'dotfiles', selected: true, panes: [pane([surfaceNode('surf1', { title: 'my agent', focused: true })])] },
    ])

  it('sends terminal.paste with workspace_id, surface_id and submit_key, inline text under inlineMaxChars', async () => {
    fake = await startFakeCmux({
      'system.tree': treeWithSurface,
      'terminal.paste': () => ({ workspace_id: 'w1', surface_id: 'surf1', submitted: true }),
    })
    const attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const result = await postPrompt(
      { target: 'surf1', prompt: 'make it red', element },
      { socketPath: fake.socketPath, inlineMaxChars: 100000, roots: ['/repo'], attachmentDir },
    )

    expect(result).toEqual({
      ok: true,
      target: 'surf1',
      title: 'my agent',
      pane_id: 'surf1',
      screenshot: null,
      submitted: true,
      submit_error: null,
    })

    const paste = fake.received.find((r) => r.method === 'terminal.paste')
    expect(paste?.params).toMatchObject({ workspace_id: 'w1', surface_id: 'surf1', submit_key: 'return' })
    const text = paste?.params.text as string
    expect(text).toContain('Focus: /repo/src/components/Button.tsx:42:10')
    expect(text).not.toContain('Details:')

    const files = await readdir(attachmentDir)
    expect(files).toHaveLength(0)
  })

  it('reports submitted:false with submit_error as a success, not a thrown error', async () => {
    fake = await startFakeCmux({
      'system.tree': treeWithSurface,
      'terminal.paste': () => ({ workspace_id: 'w1', surface_id: 'surf1', submitted: false, submit_error: 'surface busy' }),
    })
    const attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const result = await postPrompt(
      { target: 'surf1', prompt: 'make it red', element },
      { socketPath: fake.socketPath, inlineMaxChars: 100000, roots: ['/repo'], attachmentDir },
    )

    expect(result.ok).toBe(true)
    expect(result.submitted).toBe(false)
    expect(result.submit_error).toBe('surface busy')
  })

  it('throws surface_unavailable when the target surface id is not in the tree', async () => {
    fake = await startFakeCmux({ 'system.tree': treeWithSurface })
    const attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    await expect(
      postPrompt(
        { target: 'nope', prompt: 'x', element },
        { socketPath: fake.socketPath, inlineMaxChars: 100000, roots: ['/repo'], attachmentDir },
      ),
    ).rejects.toMatchObject({ code: 'surface_unavailable' })
  })

  it('resolves a target surface nested in a non-first pane of the workspace', async () => {
    fake = await startFakeCmux({
      'system.tree': () =>
        treeWith([
          {
            id: 'w1',
            index: 0,
            title: 'split',
            selected: true,
            panes: [pane([surfaceNode('surf1')]), pane([surfaceNode('surf2', { title: 'my agent', focused: true })])],
          },
        ]),
      'terminal.paste': () => ({ workspace_id: 'w1', surface_id: 'surf2', submitted: true }),
    })
    const attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const result = await postPrompt(
      { target: 'surf2', prompt: 'x', element },
      { socketPath: fake.socketPath, inlineMaxChars: 100000, roots: ['/repo'], attachmentDir },
    )

    expect(result.ok).toBe(true)
    expect(result.title).toBe('my agent')
    const paste = fake.received.find((r) => r.method === 'terminal.paste')
    expect(paste?.params).toMatchObject({ workspace_id: 'w1', surface_id: 'surf2' })
  })

  it('writes an attachment file when over inlineMaxChars', async () => {
    fake = await startFakeCmux({
      'system.tree': treeWithSurface,
      'terminal.paste': () => ({ workspace_id: 'w1', surface_id: 'surf1', submitted: true }),
    })
    const attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const result = await postPrompt(
      { target: 'surf1', prompt: 'make it red', element },
      { socketPath: fake.socketPath, inlineMaxChars: 5, roots: ['/repo'], attachmentDir },
    )

    expect(result.ok).toBe(true)
    const text = fake.received.find((r) => r.method === 'terminal.paste')?.params.text as string
    expect(text).toContain('Details:')
    expect(text).toContain('Focus: /repo/src/components/Button.tsx:42:10')

    const files = await readdir(attachmentDir)
    expect(files).toHaveLength(1)
  })

  it('writes a PNG file from base64 screenshotPng and includes the path in the sent text', async () => {
    fake = await startFakeCmux({
      'system.tree': treeWithSurface,
      'terminal.paste': () => ({ workspace_id: 'w1', surface_id: 'surf1', submitted: true }),
    })
    const attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))
    const screenshotPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

    const result = await postPrompt(
      { target: 'surf1', prompt: 'test', element, screenshotPng },
      { socketPath: fake.socketPath, inlineMaxChars: 100000, roots: ['/repo'], attachmentDir },
    )

    expect(result.ok).toBe(true)
    expect(result.screenshot).toBeTruthy()
    expect(result.screenshot?.endsWith('.png')).toBe(true)

    const text = fake.received.find((r) => r.method === 'terminal.paste')?.params.text as string
    expect(text).toContain(`Screenshot: ${result.screenshot} (real pixels, the picked element is outlined, 40px margin)`)

    const files = await readdir(attachmentDir)
    expect(files.some((f) => f.endsWith('.png'))).toBe(true)
  })
})

describe('writeAttachment', () => {
  it('writes the content and returns an absolute path that exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmp-wa-'))
    const filePath = await writeAttachment('hello world', dir)
    expect(filePath.startsWith(dir)).toBe(true)
    const content = await import('node:fs/promises').then((fs) => fs.readFile(filePath, 'utf8'))
    expect(content).toBe('hello world')
  })
})

describe('cleanupAttachments', () => {
  it('removes old .md files and keeps fresh ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmp-cleanup-'))
    const oldFile = join(dir, 'old.md')
    const freshFile = join(dir, 'fresh.md')
    await writeFile(oldFile, 'old')
    await writeFile(freshFile, 'fresh')

    const old = new Date(Date.now() - 2 * 86400000)
    await utimes(oldFile, old, old)

    await cleanupAttachments(dir, 86400000)

    const remaining = await readdir(dir)
    expect(remaining).toEqual(['fresh.md'])
  })

  it('ignores a missing directory', async () => {
    await expect(cleanupAttachments('/nonexistent/dir/for/sure')).resolves.toBeUndefined()
  })
})

describe('spawnAgent', () => {
  let fake: FakeCmux | undefined
  let stateDir: string

  afterEach(async () => {
    await fake?.close()
    fake = undefined
  })

  const fastPoll = { pollIntervalMs: 10, pollTimeoutMs: 200 }

  it('mode here splits the focused surface and returns once the hook binds a session', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))
    await writeHookStore(stateDir, 'claude', { surfaceId: 'surf-new', sessionId: 'sess1', lifecycle: 'idle' })

    fake = await startFakeCmux({
      'system.tree': () =>
        treeWith([{ id: 'w1', index: 0, title: 'dotfiles', selected: true, panes: [pane([surfaceNode('surf1', { focused: true })])] }]),
      'extension.sidebar.snapshot': () => ({ workspaces: [sidebarWorkspace('w1', { currentDirectory: '/repo' })] }),
      'surface.split': () => ({ surface_id: 'surf-new' }),
      'surface.send_text': () => ({}),
      'surface.send_key': () => ({}),
    })

    const result = await spawnAgent({ mode: 'here' }, { socketPath: fake.socketPath, stateDir, ...fastPoll })

    expect(result.ok).toBe(true)
    expect(result.pane_id).toBe('surf-new')
    expect(result.workspace_id).toBe('w1')
    expect(result.name).toMatch(/^pick-[0-9a-f]{4}$/)

    const split = fake.received.find((r) => r.method === 'surface.split')
    expect(split?.params).toEqual({ direction: 'right', surface_id: 'surf1', workspace_id: 'w1', focus: false })
    // Regression: live cmux 0.64.22 probing showed initial_input never types into the new
    // surface (it comes up as a bare shell with nothing typed) - never put it back here.
    expect(split?.params).not.toHaveProperty('initial_input')

    // The split call, then send_text/send_key against the NEW surface (surf-new), not the
    // focused one (surf1), in that order.
    const spawnCalls = fake.received.filter((r) => ['surface.split', 'surface.send_text', 'surface.send_key'].includes(r.method))
    expect(spawnCalls.map((r) => r.method)).toEqual(['surface.split', 'surface.send_text', 'surface.send_key'])
    expect(spawnCalls[1]?.params).toEqual({ surface_id: 'surf-new', text: 'claude' })
    expect(spawnCalls[2]?.params).toEqual({ surface_id: 'surf-new', key: 'enter' })
  })

  it('mode here honors an explicit name', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))
    await writeHookStore(stateDir, 'claude', { surfaceId: 'surf-new', sessionId: 'sess1', lifecycle: 'idle' })

    fake = await startFakeCmux({
      'system.tree': () =>
        treeWith([{ id: 'w1', index: 0, title: 'dotfiles', selected: true, panes: [pane([surfaceNode('surf1', { focused: true })])] }]),
      'extension.sidebar.snapshot': () => ({ workspaces: [] }),
      'surface.split': () => ({ surface_id: 'surf-new' }),
      'surface.send_text': () => ({}),
      'surface.send_key': () => ({}),
    })

    const result = await spawnAgent({ mode: 'here', name: 'my-agent' }, { socketPath: fake.socketPath, stateDir, ...fastPoll })
    expect(result.name).toBe('my-agent')
  })

  it('mode here throws surface_unavailable as a CmuxError when nothing is focused', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))
    fake = await startFakeCmux({
      'system.tree': () => ({ windows: [] }),
      'extension.sidebar.snapshot': () => ({ workspaces: [] }),
    })

    const promise = spawnAgent({ mode: 'here' }, { socketPath: fake.socketPath, stateDir, ...fastPoll })
    await expect(promise).rejects.toBeInstanceOf(CmuxError)
    await expect(promise.catch((e) => e)).resolves.toMatchObject({ code: 'surface_unavailable' })
  })

  it('mode worktree runs git rev-parse then worktree add -b for a new branch, then workspace.create', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))
    await writeHookStore(stateDir, 'claude', { surfaceId: 'surf-new', sessionId: 'sess1', lifecycle: 'idle' })

    fake = await startFakeCmux({
      'system.tree': () => treeWith([{ id: 'w1', index: 0, title: 'app', selected: true, panes: [] }]),
      'extension.sidebar.snapshot': () => ({ workspaces: [sidebarWorkspace('w1', { projectRootPath: '/home/me/app', currentDirectory: '/home/me/app' })] }),
      'workspace.create': () => ({ workspace_id: 'w2', surface_id: 'surf-new' }),
      'surface.send_text': () => ({}),
      'surface.send_key': () => ({}),
    })

    const calls: { args: string[]; cwd: string }[] = []
    const git = async (args: string[], cwd: string) => {
      calls.push({ args, cwd })
      if (args[0] === 'rev-parse') throw new Error('not a valid ref') // branch does not exist yet
      return { stdout: '', stderr: '' }
    }

    const result = await spawnAgent(
      { mode: 'worktree', name: 'feature-x' },
      { socketPath: fake.socketPath, stateDir, git, ...fastPoll },
    )

    expect(result.ok).toBe(true)
    expect(result.pane_id).toBe('surf-new')
    expect(result.workspace_id).toBe('w2')

    expect(calls[0]).toEqual({ args: ['rev-parse', '--verify', 'feature-x'], cwd: '/home/me/app' })
    expect(calls[1]).toEqual({ args: ['worktree', 'add', '-b', 'feature-x', '/home/me/app-feature-x'], cwd: '/home/me/app' })

    const created = fake.received.find((r) => r.method === 'workspace.create')
    expect(created?.params).toEqual({ title: 'feature-x', cwd: '/home/me/app-feature-x', focus: false })
    // Regression: live cmux 0.64.22 probing showed initial_input never types into the new
    // surface (it comes up as a bare shell with nothing typed) - never put it back here.
    expect(created?.params).not.toHaveProperty('initial_input')

    // The create call, then send_text/send_key against the NEW surface (surf-new), in that order.
    const spawnCalls = fake.received.filter((r) => ['workspace.create', 'surface.send_text', 'surface.send_key'].includes(r.method))
    expect(spawnCalls.map((r) => r.method)).toEqual(['workspace.create', 'surface.send_text', 'surface.send_key'])
    expect(spawnCalls[1]?.params).toEqual({ surface_id: 'surf-new', text: 'claude' })
    expect(spawnCalls[2]?.params).toEqual({ surface_id: 'surf-new', key: 'enter' })
  })

  it('mode worktree runs worktree add without -b when the branch already exists', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))
    await writeHookStore(stateDir, 'claude', { surfaceId: 'surf-new', sessionId: 'sess1', lifecycle: 'idle' })

    fake = await startFakeCmux({
      'system.tree': () => treeWith([{ id: 'w1', index: 0, title: 'app', selected: true, panes: [] }]),
      'extension.sidebar.snapshot': () => ({ workspaces: [sidebarWorkspace('w1', { rootPath: '/home/me/app', currentDirectory: '/home/me/app' })] }),
      'workspace.create': () => ({ workspace_id: 'w2', surface_id: 'surf-new' }),
      'surface.send_text': () => ({}),
      'surface.send_key': () => ({}),
    })

    const calls: { args: string[]; cwd: string }[] = []
    const git = async (args: string[], cwd: string) => {
      calls.push({ args, cwd })
      return { stdout: '', stderr: '' } // rev-parse succeeds: branch already exists
    }

    await spawnAgent({ mode: 'worktree', branch: 'existing-branch', name: 'wt' }, { socketPath: fake.socketPath, stateDir, git, ...fastPoll })

    expect(calls[0]).toEqual({ args: ['rev-parse', '--verify', 'existing-branch'], cwd: '/home/me/app' })
    expect(calls[1]).toEqual({ args: ['worktree', 'add', '/home/me/app-wt', 'existing-branch'], cwd: '/home/me/app' })
  })

  it('throws agent_not_ready when the hook store never binds the new surface within the poll timeout', async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'cmp-state-'))
    // No hook store written at all: the new surface never shows up as active

    fake = await startFakeCmux({
      'system.tree': () =>
        treeWith([{ id: 'w1', index: 0, title: 'dotfiles', selected: true, panes: [pane([surfaceNode('surf1', { focused: true })])] }]),
      'extension.sidebar.snapshot': () => ({ workspaces: [] }),
      'surface.split': () => ({ surface_id: 'surf-new' }),
      'surface.send_text': () => ({}),
      'surface.send_key': () => ({}),
    })

    const promise = spawnAgent({ mode: 'here' }, { socketPath: fake.socketPath, stateDir, pollIntervalMs: 10, pollTimeoutMs: 30 })
    await expect(promise).rejects.toBeInstanceOf(CmuxError)
    await expect(promise.catch((e) => e)).resolves.toMatchObject({
      code: 'agent_not_ready',
      message: expect.stringContaining('trust a folder'),
    })
  })
})
