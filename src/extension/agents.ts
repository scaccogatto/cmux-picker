import type { AgentRow, StateResponse, WorkspaceRow } from '../types.ts'

/// The live-state branch of StateResponse, narrowed once and reused everywhere agents are handled
export type LiveState = Extract<StateResponse, { cmux: true }>

/// One workspace and the agents running in it
export interface AgentGroup {
  workspace: WorkspaceRow
  agents: AgentRow[]
}

function synthesizedWorkspace(workspaceId: string): WorkspaceRow {
  return { workspace_id: workspaceId, label: null, number: null, focused: false }
}

function paneNumber(paneId: string): number {
  const match = paneId.match(/:p(\d+)/)
  return match !== null ? Number(match[1]) : 0
}

function compareWorkspaces(a: WorkspaceRow, b: WorkspaceRow): number {
  if (a.number === null && b.number === null) return a.workspace_id.localeCompare(b.workspace_id)
  if (a.number === null) return 1
  if (b.number === null) return -1
  if (a.number !== b.number) return a.number - b.number
  return a.workspace_id.localeCompare(b.workspace_id)
}

/// Group agents by workspace, ordered by workspace.number then workspace_id, agents ordered by pane id
export function groupAgents(state: LiveState): AgentGroup[] {
  const workspaceById = new Map(state.workspaces.map((w) => [w.workspace_id, w]))

  const agentsByWorkspace = new Map<string, AgentRow[]>()
  for (const agent of state.agents) {
    const existing = agentsByWorkspace.get(agent.workspace_id)
    if (existing !== undefined) existing.push(agent)
    else agentsByWorkspace.set(agent.workspace_id, [agent])
  }

  const groups: AgentGroup[] = Array.from(agentsByWorkspace.entries()).map(([workspaceId, agents]) => ({
    workspace: workspaceById.get(workspaceId) ?? synthesizedWorkspace(workspaceId),
    agents: [...agents].sort((a, b) => paneNumber(a.pane_id) - paneNumber(b.pane_id)),
  }))

  return groups.sort((a, b) => compareWorkspaces(a.workspace, b.workspace))
}

/// Selectable (non-blocked) pane ids, flattened in group order
export function selectableIds(groups: AgentGroup[]): string[] {
  return groups.flatMap((g) => g.agents.filter((a) => a.agent_status !== 'blocked').map((a) => a.pane_id))
}

/// Label of the focused workspace reported by the host - so "+ agent here" (which splits a pane
/// next to its focused pane) names this workspace specifically. Null when workspaceId is
/// unset, no workspace matches it, or the match has no label - callers show a generic fallback
/// rather than falling back to the raw workspace id.
export function devWorkspaceLabel(state: LiveState): string | null {
  return state.workspaces.find((w) => w.workspace_id === state.workspaceId)?.label ?? null
}

/// Preselect a target agent: last used pane, then last used session, then a live agent in the
/// current workspace, then any focused agent, then the first selectable agent
export function pickAgent(state: LiveState, last: { pane_id: string; session: string | null } | null): string | null {
  const selectable = groupAgents(state)
    .flatMap((g) => g.agents)
    .filter((a) => a.agent_status !== 'blocked')

  const byPane = last !== null ? selectable.find((a) => a.pane_id === last.pane_id) : undefined
  if (byPane !== undefined) return byPane.pane_id

  const bySession = last?.session != null ? selectable.find((a) => a.session === last.session) : undefined
  if (bySession !== undefined) return bySession.pane_id

  const idleInWorkspace = selectable.find(
    (a) => a.workspace_id === state.workspaceId && (a.agent_status === 'idle' || a.agent_status === 'done'),
  )
  if (idleInWorkspace !== undefined) return idleInWorkspace.pane_id

  const anyInWorkspace = selectable.find((a) => a.workspace_id === state.workspaceId)
  if (anyInWorkspace !== undefined) return anyInWorkspace.pane_id

  const focused = selectable.find((a) => a.focused)
  if (focused !== undefined) return focused.pane_id

  return selectable[0]?.pane_id ?? null
}
