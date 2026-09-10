// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { groupAgents, selectableIds, pickAgent, devWorkspaceLabel } from '../extension/agents.ts'
import type { LiveState } from '../extension/agents.ts'
import type { AgentRow, WorkspaceRow } from '../types.ts'

// Deterministic, UUID-shaped surface ids: cmux surfaces are UUIDs, not colon-parseable "w1:p2" pane numbers.
const SF1 = '11111111-1111-4111-8111-111111111111'
const SF2 = '22222222-2222-4222-8222-222222222222'
const SF3 = '33333333-3333-4333-8333-333333333333'
const SF4 = '44444444-4444-4444-8444-444444444444'

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
    version: '0.64.22',
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
        agent({ pane_id: SF1, workspace_id: 'wb' }),
        agent({ pane_id: SF2, workspace_id: 'w2' }),
        agent({ pane_id: SF3, workspace_id: 'wa' }),
        agent({ pane_id: SF4, workspace_id: 'w1' }),
      ],
    })

    const groups = groupAgents(s)
    expect(groups.map((g) => g.workspace.workspace_id)).toEqual(['w1', 'w2', 'wa', 'wb'])
  })

  it('keeps agents within a group in the order the host returned them, not sorted by id', () => {
    const s = state({
      workspaces: [workspace({ workspace_id: 'w1', number: 1 })],
      agents: [
        agent({ pane_id: SF3, workspace_id: 'w1' }),
        agent({ pane_id: SF1, workspace_id: 'w1' }),
        agent({ pane_id: SF2, workspace_id: 'w1' }),
      ],
    })

    const groups = groupAgents(s)
    expect(groups[0]?.agents.map((a) => a.pane_id)).toEqual([SF3, SF1, SF2])
  })

  it('synthesizes a workspace row when workspace_id has no matching WorkspaceRow', () => {
    const s = state({
      workspaces: [],
      agents: [agent({ pane_id: SF1, workspace_id: 'ghost' })],
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

  it('keeps blocked agents in their group, in host order', () => {
    const s = state({
      workspaces: [workspace({ workspace_id: 'w1', number: 1 })],
      agents: [
        agent({ pane_id: SF2, workspace_id: 'w1', agent_status: 'blocked' }),
        agent({ pane_id: SF1, workspace_id: 'w1', agent_status: 'idle' }),
      ],
    })

    const groups = groupAgents(s)
    expect(groups[0]?.agents.map((a) => a.pane_id)).toEqual([SF2, SF1])
  })

  it('omits a workspace that has no agents', () => {
    const s = state({
      workspaces: [workspace({ workspace_id: 'w1', number: 1 }), workspace({ workspace_id: 'w2', number: 2 })],
      agents: [agent({ pane_id: SF1, workspace_id: 'w1' })],
    })

    const groups = groupAgents(s)
    expect(groups.map((g) => g.workspace.workspace_id)).toEqual(['w1'])
  })
})

describe('selectableIds', () => {
  it('flattens surface ids in group order, excluding blocked agents', () => {
    const s = state({
      workspaces: [workspace({ workspace_id: 'w1', number: 1 }), workspace({ workspace_id: 'w2', number: 2 })],
      agents: [
        agent({ pane_id: SF2, workspace_id: 'w1', agent_status: 'blocked' }),
        agent({ pane_id: SF1, workspace_id: 'w1', agent_status: 'idle' }),
        agent({ pane_id: SF3, workspace_id: 'w2', agent_status: 'working' }),
      ],
    })

    expect(selectableIds(groupAgents(s))).toEqual([SF1, SF3])
  })
})

describe('pickAgent', () => {
  const s = state({
    workspaceId: 'w1',
    workspaces: [workspace({ workspace_id: 'w1', number: 1 }), workspace({ workspace_id: 'w2', number: 2 })],
    agents: [
      agent({ pane_id: SF1, workspace_id: 'w1', agent_status: 'working', session: 's1', focused: false }),
      agent({ pane_id: SF2, workspace_id: 'w1', agent_status: 'idle', session: 's2', focused: false }),
      agent({ pane_id: SF3, workspace_id: 'w1', agent_status: 'blocked', session: 's3', focused: false }),
      agent({ pane_id: SF4, workspace_id: 'w2', agent_status: 'working', session: 's4', focused: true }),
    ],
  })

  it('prefers last.pane_id when it is selectable', () => {
    expect(pickAgent(s, { pane_id: SF4, session: null })).toBe(SF4)
  })

  it('falls through to last.session when last.pane_id does not match a selectable agent', () => {
    expect(pickAgent(s, { pane_id: 'gone', session: 's4' })).toBe(SF4)
  })

  it('ignores a last.pane_id that points at a blocked agent, and falls through', () => {
    expect(pickAgent(s, { pane_id: SF3, session: null })).toBe(SF2)
  })

  it('picks an idle/done agent in state.workspaceId when there is no last match', () => {
    expect(pickAgent(s, null)).toBe(SF2)
  })

  it('picks any agent in state.workspaceId when none there are idle or done', () => {
    const noIdle = state({
      workspaceId: 'w1',
      workspaces: [workspace({ workspace_id: 'w1', number: 1 })],
      agents: [agent({ pane_id: SF1, workspace_id: 'w1', agent_status: 'working' })],
    })
    expect(pickAgent(noIdle, null)).toBe(SF1)
  })

  it('picks a focused agent when nothing matches in state.workspaceId', () => {
    const noWorkspaceMatch = state({
      workspaceId: 'wX',
      workspaces: [workspace({ workspace_id: 'w1', number: 1 })],
      agents: [
        agent({ pane_id: SF1, workspace_id: 'w1', agent_status: 'working', focused: false }),
        agent({ pane_id: SF2, workspace_id: 'w1', agent_status: 'working', focused: true }),
      ],
    })
    expect(pickAgent(noWorkspaceMatch, null)).toBe(SF2)
  })

  it('falls back to the first selectable agent (host order) when nothing else matches', () => {
    const nothingMatches = state({
      workspaceId: 'wX',
      workspaces: [workspace({ workspace_id: 'w1', number: 1 })],
      agents: [
        agent({ pane_id: SF2, workspace_id: 'w1', agent_status: 'working', focused: false }),
        agent({ pane_id: SF1, workspace_id: 'w1', agent_status: 'working', focused: false }),
      ],
    })
    expect(pickAgent(nothingMatches, null)).toBe(SF2)
  })

  it('returns null when there are no selectable agents', () => {
    const allBlocked = state({
      agents: [agent({ pane_id: SF1, workspace_id: 'w1', agent_status: 'blocked' })],
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
