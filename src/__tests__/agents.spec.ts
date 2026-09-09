// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { groupAgents, selectableIds, pickAgent, devWorkspaceLabel } from '../extension/agents.ts'
import type { LiveState } from '../extension/agents.ts'
import type { AgentRow, WorkspaceRow } from '../types.ts'

function agent(overrides: Partial<AgentRow> & { pane_id: string; workspace_id: string }): AgentRow {
  return {
    agent_status: 'idle',
    agent: 'claude',
    title: null,
    branch: null,
    session: null,
    focused: false,
    cwd: null,
    ...overrides,
  }
}

function workspace(overrides: Partial<WorkspaceRow> & { workspace_id: string }): WorkspaceRow {
  return { label: null, number: null, focused: false, ...overrides }
}

function state(overrides: Partial<LiveState>): LiveState {
  return {
    cmux: true,
    version: '0.8.2',
    protocol: 1,
    workspaceId: null,
    paneId: null,
    workspaces: [],
    agents: [],
    screenshot: 'off',
    ...overrides,
  }
}

describe('groupAgents', () => {
  it('orders groups by workspace.number ascending, with null numbers last, ties by workspace_id', () => {
    const s = state({
      workspaces: [
        workspace({ workspace_id: 'wb', number: null }),
        workspace({ workspace_id: 'w2', number: 2 }),
        workspace({ workspace_id: 'wa', number: null }),
        workspace({ workspace_id: 'w1', number: 1 }),
      ],
      agents: [
        agent({ pane_id: 'wb:p1', workspace_id: 'wb' }),
        agent({ pane_id: 'w2:p1', workspace_id: 'w2' }),
        agent({ pane_id: 'wa:p1', workspace_id: 'wa' }),
        agent({ pane_id: 'w1:p1', workspace_id: 'w1' }),
      ],
    })

    const groups = groupAgents(s)
    expect(groups.map((g) => g.workspace.workspace_id)).toEqual(['w1', 'w2', 'wa', 'wb'])
  })

  it('orders agents within a group by the numeric part of the pane id', () => {
    const s = state({
      workspaces: [workspace({ workspace_id: 'w1', number: 1 })],
      agents: [
        agent({ pane_id: 'w1:p10', workspace_id: 'w1' }),
        agent({ pane_id: 'w1:p2', workspace_id: 'w1' }),
        agent({ pane_id: 'w1:p1', workspace_id: 'w1' }),
      ],
    })

    const groups = groupAgents(s)
    expect(groups[0]?.agents.map((a) => a.pane_id)).toEqual(['w1:p1', 'w1:p2', 'w1:p10'])
  })

  it('synthesizes a workspace row when workspace_id has no matching WorkspaceRow', () => {
    const s = state({
      workspaces: [],
      agents: [agent({ pane_id: 'ghost:p1', workspace_id: 'ghost' })],
    })

    const groups = groupAgents(s)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.workspace).toEqual({
      workspace_id: 'ghost',
      label: null,
      number: null,
      focused: false,
    })
  })

  it('keeps blocked agents in their group', () => {
    const s = state({
      workspaces: [workspace({ workspace_id: 'w1', number: 1 })],
      agents: [
        agent({ pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'idle' }),
        agent({ pane_id: 'w1:p2', workspace_id: 'w1', agent_status: 'blocked' }),
      ],
    })

    const groups = groupAgents(s)
    expect(groups[0]?.agents.map((a) => a.pane_id)).toEqual(['w1:p1', 'w1:p2'])
  })

  it('omits a workspace that has no agents', () => {
    const s = state({
      workspaces: [workspace({ workspace_id: 'w1', number: 1 }), workspace({ workspace_id: 'w2', number: 2 })],
      agents: [agent({ pane_id: 'w1:p1', workspace_id: 'w1' })],
    })

    const groups = groupAgents(s)
    expect(groups.map((g) => g.workspace.workspace_id)).toEqual(['w1'])
  })
})

describe('selectableIds', () => {
  it('flattens pane ids in group order, excluding blocked agents', () => {
    const s = state({
      workspaces: [workspace({ workspace_id: 'w1', number: 1 }), workspace({ workspace_id: 'w2', number: 2 })],
      agents: [
        agent({ pane_id: 'w1:p2', workspace_id: 'w1', agent_status: 'blocked' }),
        agent({ pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'idle' }),
        agent({ pane_id: 'w2:p1', workspace_id: 'w2', agent_status: 'working' }),
      ],
    })

    expect(selectableIds(groupAgents(s))).toEqual(['w1:p1', 'w2:p1'])
  })
})

describe('pickAgent', () => {
  const s = state({
    workspaceId: 'w1',
    workspaces: [workspace({ workspace_id: 'w1', number: 1 }), workspace({ workspace_id: 'w2', number: 2 })],
    agents: [
      agent({ pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working', session: 's1', focused: false }),
      agent({ pane_id: 'w1:p2', workspace_id: 'w1', agent_status: 'idle', session: 's2', focused: false }),
      agent({ pane_id: 'w1:p3', workspace_id: 'w1', agent_status: 'blocked', session: 's3', focused: false }),
      agent({ pane_id: 'w2:p1', workspace_id: 'w2', agent_status: 'working', session: 's4', focused: true }),
    ],
  })

  it('prefers last.pane_id when it is selectable', () => {
    expect(pickAgent(s, { pane_id: 'w2:p1', session: null })).toBe('w2:p1')
  })

  it('falls through to last.session when last.pane_id does not match a selectable agent', () => {
    expect(pickAgent(s, { pane_id: 'gone:p9', session: 's4' })).toBe('w2:p1')
  })

  it('ignores a last.pane_id that points at a blocked agent, and falls through', () => {
    expect(pickAgent(s, { pane_id: 'w1:p3', session: null })).toBe('w1:p2')
  })

  it('picks an idle/done agent in state.workspaceId when there is no last match', () => {
    expect(pickAgent(s, null)).toBe('w1:p2')
  })

  it('picks any agent in state.workspaceId when none there are idle or done', () => {
    const noIdle = state({
      workspaceId: 'w1',
      workspaces: [workspace({ workspace_id: 'w1', number: 1 })],
      agents: [agent({ pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working' })],
    })
    expect(pickAgent(noIdle, null)).toBe('w1:p1')
  })

  it('picks a focused agent when nothing matches in state.workspaceId', () => {
    const noWorkspaceMatch = state({
      workspaceId: 'wX',
      workspaces: [workspace({ workspace_id: 'w1', number: 1 })],
      agents: [
        agent({ pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working', focused: false }),
        agent({ pane_id: 'w1:p2', workspace_id: 'w1', agent_status: 'working', focused: true }),
      ],
    })
    expect(pickAgent(noWorkspaceMatch, null)).toBe('w1:p2')
  })

  it('falls back to the first selectable agent when nothing else matches', () => {
    const nothingMatches = state({
      workspaceId: 'wX',
      workspaces: [workspace({ workspace_id: 'w1', number: 1 })],
      agents: [
        agent({ pane_id: 'w1:p2', workspace_id: 'w1', agent_status: 'working', focused: false }),
        agent({ pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'working', focused: false }),
      ],
    })
    expect(pickAgent(nothingMatches, null)).toBe('w1:p1')
  })

  it('returns null when there are no selectable agents', () => {
    const allBlocked = state({
      agents: [agent({ pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'blocked' })],
    })
    expect(pickAgent(allBlocked, null)).toBeNull()
  })
})

describe('devWorkspaceLabel', () => {
  it('returns the label of the workspace matching workspaceId', () => {
    const s = state({ workspaceId: 'w1', workspaces: [workspace({ workspace_id: 'w1', label: 'app' })] })
    expect(devWorkspaceLabel(s)).toBe('app')
  })

  it('returns null when workspaceId is null', () => {
    const s = state({ workspaceId: null, workspaces: [workspace({ workspace_id: 'w1', label: 'app' })] })
    expect(devWorkspaceLabel(s)).toBeNull()
  })

  it('returns null when no workspace matches workspaceId', () => {
    const s = state({ workspaceId: 'w3F', workspaces: [workspace({ workspace_id: 'w1', label: 'app' })] })
    expect(devWorkspaceLabel(s)).toBeNull()
  })

  it('returns null when the matching workspace has no label, without falling back to the raw id', () => {
    const s = state({ workspaceId: 'w1', workspaces: [workspace({ workspace_id: 'w1', label: null })] })
    expect(devWorkspaceLabel(s)).toBeNull()
  })
})
