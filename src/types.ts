/** Bounding box of the element: position and dimensions */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Current viewport dimensions */
export interface Viewport {
  w: number
  h: number
}

/** Captured information about the picked DOM element */
export interface ElementInfo {
  url: string
  viewport: Viewport
  hint: string | null
  path: string
  rect: Rect
  html: string
  styles: Record<string, string>
}

/** Status of a cmux agent */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

/** One cmux agent as shown in the popup */
export interface AgentRow {
  /** cmux surface UUID (a terminal surface within a workspace) */
  pane_id: string
  /** cmux workspace UUID */
  workspace_id: string
  agent_status: AgentStatus
  agent: string | null
  title: string | null
  branch: string | null
  session: string | null
  focused: boolean
  cwd: string | null
}

/** One cmux workspace */
export interface WorkspaceRow {
  /** cmux workspace UUID */
  workspace_id: string
  label: string | null
  number: number | null
  focused: boolean
}

/** Response from GET /__cmux/state */
export type StateResponse =
  | {
      cmux: true
      workspaceId: string | null
      paneId: string | null
      workspaces: WorkspaceRow[]
      agents: AgentRow[]
      /** Whether the opt-in real-pixel screenshot can be attached to a prompt */
      screenshot: 'available' | 'unsupported' | 'off'
    }
  | { cmux: false; reason: string; message: string }

/** Request body for POST /__cmux/prompt */
export interface PromptRequest {
  target: string
  prompt: string
  element: ElementInfo
  /** Up to 4 additional picked elements; the first selected element stays in `element` */
  extras?: ElementInfo[]
  /** Base64 PNG of the picked element's real pixels, captured by the extension, present when the sender opted in */
  screenshotPng?: string
}

/** Successful response from POST /__cmux/prompt */
export interface PromptResponse {
  ok: true
  target: string
  title: string | null
  pane_id: string | null
  /** Absolute path to the captured screenshot, or null when none was captured */
  screenshot: string | null
  /** Whether terminal.paste submitted the text, or left it sitting unsubmitted at the prompt */
  submitted: boolean
  /** cmux's own explanation when submitted is false, else null */
  submit_error: string | null
}

/** Request body for POST /__cmux/spawn */
export interface SpawnRequest {
  mode: 'here' | 'worktree'
  name?: string
  branch?: string
}

/** Successful response from POST /__cmux/spawn */
export interface SpawnResponse {
  ok: true
  pane_id: string
  name: string
  workspace_id: string | null
}

/** Error response from the endpoints */
export interface ErrorResponse {
  error: string
  message: string
}
