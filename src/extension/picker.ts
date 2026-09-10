import type {
  AgentRow,
  ElementInfo,
  ErrorResponse,
  PromptRequest,
  PromptResponse,
  Rect,
  SpawnRequest,
  SpawnResponse,
  StateResponse,
} from '../types.ts'
import { composePrompt } from '../compose.ts'
import {
  HOST_ATTR,
  deepElementFromPoint,
  describeElement,
  popupPathLabel,
  selectorPath,
  sourceHint,
  spawnHint,
  stripHintSuffix,
  truncateStart,
} from './dom.ts'
import { devWorkspaceLabel, groupAgents, pickAgent, selectableIds } from './agents.ts'

/** How the picker reaches the native host, implemented by the content script */
export interface Relay {
  state(): Promise<StateResponse>
  prompt(body: PromptRequest): Promise<RelayReply<PromptResponse>>
  spawn(body: SpawnRequest): Promise<RelayReply<SpawnResponse>>
  /** Real pixels of the viewport rect (CSS px) plus a margin, as base64 PNG; rejects when capture is unavailable */
  capture(rect: Rect): Promise<string>
}

export interface RelayReply<T> { status: number; body: T | ErrorResponse }

/** Max total picked elements: the primary plus up to 4 extras */
const MAX_SELECTION = 5

const MAX_DEPTH = 3
const MAX_LINES = 60

/**
 * Grace window before the in-flight poll accepts a settled status it never saw pass through
 * 'working'. cmux only reports 'working' after Claude Code's prompt-submit hook runs, which
 * happens asynchronously in a separate CLI process, so a poll can land on an already-settled
 * (still 'idle' from before the paste) status well after the prompt went out.
 */
const INFLIGHT_STALE_GRACE_MS = 15000
/** How long the in-flight outline waits for a settle before giving up and clearing */
const INFLIGHT_MAX_MS = 30 * 60 * 1000

/** Debug/bench API exposed on window.__cmux */
export interface CmuxApi {
  version: string
  describe(el: Element): ElementInfo
  outline(el: Element | null): void
  pick(el: Element, x: number, y: number): void
  close(): void
  /** The pane id currently shown in-flight, or null */
  inflight(): string | null
  /** Selector paths of the elements added to the multi-selection via shift+click */
  selection(): string[]
  /** Whether the attach-screenshot switch is currently checked */
  screenshotEnabled(): boolean
  start(): void
}

declare global {
  interface Window {
    __cmux?: CmuxApi
  }
}

type Mode = 'idle' | 'picking' | 'popup' | 'sending'

const LAST_KEY = 'cmux:last'
const SHOT_KEY = 'cmux:shot'
const SVG_NS = 'http://www.w3.org/2000/svg'
const CHEVRON_DOWN = 'M3 4.5 6 7.5l3-3'
const CHEVRON_UP = 'M3 7.5 6 4.5l3 3'

interface Last {
  pane_id: string
  session: string | null
}

function readLast(): Last | null {
  try {
    const raw = localStorage.getItem(LAST_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<Last>
    if (typeof parsed.pane_id !== 'string') return null
    return { pane_id: parsed.pane_id, session: typeof parsed.session === 'string' ? parsed.session : null }
  } catch {
    return null
  }
}

function writeLast(last: Last): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(last))
  } catch {
    // storage unavailable (private mode, quota) - preselection just falls back next time
  }
}

function readShotPref(): boolean {
  try {
    return localStorage.getItem(SHOT_KEY) === '1'
  } catch {
    return false
  }
}

function writeShotPref(checked: boolean): void {
  try {
    localStorage.setItem(SHOT_KEY, checked ? '1' : '0')
  } catch {
    // storage unavailable (private mode, quota) - preference just won't persist
  }
}

/**
 * Explains a StateResponse.reason for the not-reachable notice, naming the fix for the
 * cases the user can act on; unrecognized reasons fall back to showing the raw code.
 */
function unreachableNotice(reason: string): string {
  if (reason === 'access_denied') {
    return 'cmux not reachable: the cmux control socket refuses external clients, set Settings > Automation to "Automation mode" or "Password mode". Enter copies the prompt'
  }
  if (reason === 'no_socket') {
    return 'cmux not reachable: cmux is not running. Enter copies the prompt'
  }
  if (reason === 'capabilities') {
    return 'cmux not reachable: the installed cmux is too old. Enter copies the prompt'
  }
  return `cmux not reachable (${reason}): Enter copies the prompt`
}

function elementLabel(el: Element): string {
  const tag = el.tagName.toLowerCase()
  const idPart = el.id.length > 0 ? `#${el.id}` : ''
  const classAttr = el.getAttribute('class')
  const classes = classAttr !== null ? classAttr.split(/\s+/).filter((c) => c.length > 0).slice(0, 2) : []
  const classPart = classes.length > 0 ? `.${classes.join('.')}` : ''
  return `${tag}${idPart}${classPart}`
}

function rowId(paneId: string): string {
  return `cmux-agent-${paneId.replace(/[^A-Za-z0-9_-]/g, '-')}`
}

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  return el
}

function buildChevron(): { svg: SVGElement; path: SVGElement } {
  const svg = svgEl('svg', {
    class: 'to-chevron',
    viewBox: '0 0 12 12',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })
  const path = svgEl('path', { d: CHEVRON_DOWN })
  svg.appendChild(path)
  return { svg, path }
}

function buildCheckIcon(): SVGElement {
  const svg = svgEl('svg', {
    viewBox: '0 0 12 12',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })
  svg.appendChild(svgEl('path', { d: 'M2.5 6.5 5 9l4.5-6' }))
  return svg
}

const STYLE = `
:host {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", Inter, "Segoe UI", Roboto, sans-serif;
  font-size: 13px; line-height: 1.4; color-scheme: light;
  --surface: rgba(252,252,253,.94); --surface-solid: #FBFBFC;
  --inset: rgba(0,0,0,.045); --inset-2: rgba(0,0,0,.075); --line: rgba(0,0,0,.10); --hair: rgba(0,0,0,.07);
  --text: #1A1A1F; --muted: #5C606B;
  --accent: #6E56CF; --accent-ink: #6650C4; --outline: var(--accent);
  --tint: rgba(110,86,207,.10); --tint-faint: rgba(110,86,207,.06); --veil: rgba(110,86,207,.14);
  --danger: #B42318; --danger-veil: rgba(180,35,24,.12);
  --ok: #17753A; --ok-veil: rgba(23,117,58,.12);
  --s-idle: var(--ok); --s-working: var(--accent); --s-blocked: var(--danger); --s-done: var(--ok); --s-unknown: #8A8D96;
  --knob: #FFFFFF; --track: rgba(0,0,0,.16);
  --shadow: 0 24px 56px -16px rgba(0,0,0,.30), 0 8px 24px -8px rgba(0,0,0,.14), 0 0 0 .5px rgba(0,0,0,.04);
  --chip-shadow: 0 4px 14px -4px rgba(0,0,0,.22);
}
@media (prefers-color-scheme: dark) {
  :host {
    color-scheme: dark;
    --surface: rgba(34,34,39,.94); --surface-solid: #222227;
    --inset: rgba(255,255,255,.06); --inset-2: rgba(255,255,255,.10); --line: rgba(255,255,255,.16); --hair: rgba(255,255,255,.08);
    --text: #EDEDF0; --muted: #A0A2AC;
    --accent: #6E56CF; --accent-ink: #A99BFF; --outline: var(--accent-ink);
    --tint: rgba(169,155,255,.14); --tint-faint: rgba(169,155,255,.08); --veil: rgba(169,155,255,.16);
    --danger: #F47067; --danger-veil: rgba(244,112,103,.14);
    --ok: #3FB950; --ok-veil: rgba(63,185,80,.14);
    --s-idle: var(--ok); --s-working: var(--accent-ink); --s-blocked: var(--danger); --s-done: var(--ok); --s-unknown: #8B8E99;
    --knob: #E4E4E7; --track: rgba(255,255,255,.20);
    --shadow: 0 24px 56px -16px rgba(0,0,0,.70), 0 8px 24px -8px rgba(0,0,0,.50), 0 0 0 1px rgba(255,255,255,.04), inset 0 1px 0 rgba(255,255,255,.07);
    --chip-shadow: 0 4px 14px -4px rgba(0,0,0,.60);
  }
}
* { box-sizing: border-box; }
button, textarea, input { font: inherit; color: inherit; }
button { background: none; border: 0; padding: 0; margin: 0; cursor: pointer; text-align: left; }
:focus-visible { outline: 2px solid var(--accent-ink); outline-offset: 1px; }
::selection { background: var(--accent); color: #fff; }

/* overlays: outline + chips (one family) */
.outline { position: fixed; display: none; border: 2px solid var(--outline); background: var(--veil); pointer-events: none; }
.chip, .inflight-chip {
  position: fixed; display: none; align-items: center; gap: 6px;
  height: 24px; padding: 0 8px; white-space: nowrap; max-width: calc(100vw - 16px); overflow: hidden;
  font: 12px/16px ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; color: var(--muted);
  background: var(--surface-solid); border: 1px solid var(--line); border-radius: 6px; box-shadow: var(--chip-shadow);
  pointer-events: none;
}
/* the container clips (overflow: hidden above); ellipsis lives on the text
   pieces themselves, which is where a flex container actually applies it */
.chip b, .inflight-chip b, .chip span, .inflight-chip span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* The hover chip's label and hint would otherwise shrink in proportion to
   their own content width, so the (usually shorter) hint loses its tail
   first; the location is the more useful half, so it keeps its size and the
   label absorbs the clipping. The in-flight chip's span is the agent title,
   which should keep absorbing width as it always has. */
.chip span { flex: 0 0 auto; max-width: 55%; }
.chip b, .inflight-chip b { font-weight: 500; color: var(--accent-ink); }
.chip i, .inflight-chip i { font-style: normal; color: var(--muted); }
.inflight-chip.done { color: var(--ok); border-color: var(--ok); }
.inflight-chip.done b { color: var(--ok); font-weight: 600; }
.inflight-chip.done i { color: var(--ok); }
.inflight-chip.blocked { color: var(--danger); border-color: var(--danger); }
.inflight-chip.blocked b { color: var(--danger); }
.inflight-chip.blocked i { color: var(--danger); }
.inflight-chip svg { width: 12px; height: 12px; flex: none; }
.multi { position: fixed; display: none; border: 2px solid var(--outline); pointer-events: none; }
.multi-badge { position: absolute; top: -9px; left: -9px; width: 18px; height: 18px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 12px; font-weight: 600; display: flex; align-items: center; justify-content: center; }
.inflight { position: fixed; display: none; border: 2px dashed var(--outline); background: var(--veil); pointer-events: none; }
.inflight.done { border-color: var(--ok); background: var(--ok-veil); }
.inflight.blocked { border-color: var(--danger); background: var(--danger-veil); }
.inflight.done, .inflight.blocked { border-style: solid; }
.toast { position: fixed; display: none; right: 16px; bottom: 16px; padding: 8px 12px; font-size: 13px; line-height: 20px; color: var(--text); background: var(--surface-solid); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--chip-shadow); pointer-events: none; max-width: min(320px, calc(100vw - 32px)); }
.toast.error { border-color: var(--danger); }

/* popup shell */
.popup {
  position: fixed; display: none; flex-direction: column;
  width: min(440px, calc(100vw - 16px)); max-height: calc(100vh - 16px); overflow: hidden;
  color: var(--text); font-size: 13px; line-height: 20px;
  background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow);
  -webkit-backdrop-filter: blur(24px) saturate(160%); backdrop-filter: blur(24px) saturate(160%);
  pointer-events: auto;
}
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .popup { background: var(--surface-solid); }
}
/* Only the agent list may shrink below its content height: every other
   direct child keeps its natural size, so a short viewport squeezes the
   scrollable list instead of clipping the footer. */
.popup > * { flex: none; }

/* header: two rows that never wrap */
.popup-header { margin: 8px 8px 0; padding: 8px 10px; border-radius: 8px; background: var(--inset); }
.popup-row { display: flex; align-items: center; gap: 12px; height: 18px; line-height: 18px; }
.popup-row + .popup-row { margin-top: 2px; }
.popup-count { flex: none; display: inline-flex; align-items: center; height: 16px; padding: 0 6px; border-radius: 4px; background: var(--tint); color: var(--accent-ink); font-size: 12px; font-weight: 500; }
.popup-label { flex: 1 1 auto; min-width: 0; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; font-weight: 500; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.popup-path { flex: 1 1 auto; min-width: 0; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
.popup-path > span { unicode-bidi: plaintext; }
.popup-hint {
  flex: 0 1 auto; min-width: 0; max-width: 70%; margin-left: auto;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; color: var(--muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: right;
}
.popup-hint > span { unicode-bidi: plaintext; }

/* prompt */
.prompt { position: relative; }
.popup textarea { display: block; width: calc(100% - 16px); margin: 4px 8px 0; padding: 8px 10px 4px; height: 72px; resize: none; background: transparent; border: 0; outline: 0; color: var(--text); font-size: 14px; line-height: 20px; caret-color: var(--accent); }
.popup textarea::placeholder { color: var(--muted); }
.popup textarea:focus-visible { outline: none; }
.popup textarea.invalid { box-shadow: inset 0 0 0 1px var(--danger); border-radius: 6px; }

/* switch: the checkbox input is the switch */
.shot-row { display: none; align-items: center; gap: 8px; margin: 0 8px 8px; padding: 0 10px; height: 24px; font-size: 12px; color: var(--muted); cursor: pointer; }
.switch { appearance: none; -webkit-appearance: none; margin: 0; width: 26px; height: 16px; border-radius: 8px; background: var(--track); position: relative; cursor: pointer; flex: none; }
.switch::before { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--knob); box-shadow: 0 1px 2px rgba(0,0,0,.25); }
.switch:checked { background: var(--accent); }
.switch:checked::before { left: 12px; }

/* one grid for the To row, agent rows and spawn rows: every cell edge lands on the same x */
.to-row, .agent-row { display: grid; grid-template-columns: 16px minmax(0,1fr) 64px 76px 48px; column-gap: 10px; align-items: center; }
.to-label { grid-column: 1; }
.to-title, .agent-title { grid-column: 2; min-width: 0; }
.to-status, .agent-status { grid-column: 3; }
.to-branch, .agent-branch { grid-column: 4; }
.to-pane, .agent-pane { grid-column: 5; }
.to-hint, .spawn-hint { grid-column: 3 / 6; }
.agent-status, .agent-branch, .agent-pane, .to-status, .to-branch, .to-pane { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; line-height: 16px; font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* Sans, not mono: these are a description ("where"), not a machine value. */
.to-hint, .spawn-hint { font-size: 12px; line-height: 16px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: right; }
.agent-pane, .to-pane { font-size: 11px; text-align: right; }
.agent-status, .to-status { display: inline-flex; align-items: center; gap: 6px; overflow: visible; }
.status-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--s-unknown); }
.status-idle { background: var(--s-idle); }
.status-working { background: var(--s-working); }
.status-blocked { background: var(--s-blocked); }
.status-done { background: var(--s-done); }

/* the To row: a field, in the same inset family as the header panel */
.to-row { width: calc(100% - 16px); margin: 0 8px 8px; padding: 0 8px; height: 36px; border-radius: 8px; background: var(--inset); }
.to-row:hover { background: var(--inset-2); }
.to-row[hidden], .agents-groups[hidden], .agents-area[hidden] { display: none; }
.to-label { font-size: 12px; font-weight: 600; color: var(--text); }
.to-title { display: flex; align-items: center; gap: 4px; font-weight: 500; color: var(--text); }
.to-name { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.to-chevron { flex: none; width: 14px; height: 14px; color: var(--text); }
.to-hint { display: none; }
.to-row.spawn .to-status, .to-row.spawn .to-branch, .to-row.spawn .to-pane { display: none; }
.to-row.spawn .to-hint { display: block; }
.to-row.spawn .to-name { color: var(--accent-ink); }
.to-row.empty .to-status, .to-row.empty .to-branch, .to-row.empty .to-pane { display: none; }
.to-row.empty .to-name { color: var(--muted); }
.agents-notice { margin: 0 8px 8px; padding: 0 8px; height: 36px; line-height: 36px; font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* the list */
.agents-area { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; border-top: 1px solid var(--hair); }
.agents-groups { flex: 1 1 auto; min-height: 0; max-height: 240px; overflow-y: auto; padding: 4px 0; border-bottom: 1px solid var(--hair); }
.agents-group-heading { display: flex; align-items: center; gap: 8px; height: 24px; padding: 0 16px; font-size: 12px; font-weight: 500; color: var(--muted); }
.focused-pill { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: 4px; background: var(--tint); color: var(--accent-ink); font-size: 12px; font-weight: 500; }
.agent-row { position: relative; height: 28px; padding: 0 16px; cursor: pointer; }
.agent-row:not(.blocked):hover { background: var(--tint-faint); }
.agent-row[aria-selected="true"] { background: var(--tint); }
.agent-row[aria-selected="true"]::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--accent); }
.agent-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
.agent-row[aria-selected="true"] .agent-title { font-weight: 500; }
.agent-row.blocked { cursor: not-allowed; }
.agent-row.blocked .agent-title { color: var(--muted); }
.agent-row.blocked .agent-status { color: var(--danger); }
/* In-progress spawn: aria-disabled stays purely semantic here, the .55 dim
   already reaches these rows through .agents-area's opacity in .popup.sending. */
.agent-row.busy { pointer-events: none; }
.spawn-group { flex: none; padding: 4px 0; }
.spawn-row .agent-title { color: var(--accent-ink); font-weight: 500; }

/* footer */
.popup-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 42px; padding: 0 8px 0 12px; border-top: 1px solid var(--hair); font-size: 12px; color: var(--muted); }
.keys { display: flex; align-items: center; gap: 12px; white-space: nowrap; }
.keys span { display: inline-flex; align-items: center; gap: 5px; }
kbd { display: inline-flex; align-items: center; justify-content: center; height: 18px; min-width: 18px; padding: 0 5px; border-radius: 4px; border: 1px solid var(--line); background: var(--inset); font-family: inherit; font-size: 12px; line-height: 1; color: var(--muted); }
.send-btn { display: inline-flex; align-items: center; height: 26px; padding: 0 12px; border-radius: 6px; background: var(--accent); color: #fff; font-size: 13px; font-weight: 600; box-shadow: 0 1px 0 rgba(0,0,0,.08); }
.send-btn:disabled { opacity: .6; cursor: default; }

.popup.sending :is(textarea, .shot-row, .to-row, .agents-area) { opacity: .55; pointer-events: none; }

@media (max-width: 420px) {
  .keys .key-esc { display: none; }
  .to-row, .agent-row { grid-template-columns: 16px minmax(0,1fr) 64px 48px; }
  .to-branch, .agent-branch { display: none; }
  .to-pane, .agent-pane { grid-column: 4; }
  .spawn-hint, .to-hint { grid-column: 3 / 5; }
}
`

export function mount(relay: Relay): void {
  const host = document.createElement('div')
  host.setAttribute(HOST_ATTR, '')
  host.style.cssText = 'position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;'
  document.body.appendChild(host)

  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = STYLE
  shadow.appendChild(style)

  const outline = document.createElement('div')
  outline.className = 'outline'
  outline.setAttribute('aria-hidden', 'true')

  const chip = document.createElement('div')
  chip.className = 'chip'
  chip.setAttribute('aria-hidden', 'true')

  const inflightBox = document.createElement('div')
  inflightBox.className = 'inflight'
  inflightBox.setAttribute('aria-hidden', 'true')

  const inflightChip = document.createElement('div')
  inflightChip.className = 'inflight-chip'
  inflightChip.setAttribute('aria-hidden', 'true')

  const popup = document.createElement('div')
  popup.className = 'popup'
  popup.setAttribute('role', 'dialog')
  popup.setAttribute('aria-label', 'Send to cmux agent')

  // --- header -----------------------------------------------------

  const header = document.createElement('div')
  header.className = 'popup-header'

  const row1 = document.createElement('div')
  row1.className = 'popup-row'
  const countEl = document.createElement('span')
  countEl.className = 'popup-count'
  const labelEl = document.createElement('span')
  labelEl.className = 'popup-label'
  row1.append(countEl, labelEl)

  const row2 = document.createElement('div')
  row2.className = 'popup-row'
  const popupPathWrap = document.createElement('span')
  popupPathWrap.className = 'popup-path'
  const popupPathInner = document.createElement('span')
  popupPathWrap.appendChild(popupPathInner)
  const popupHintEl = document.createElement('span')
  popupHintEl.className = 'popup-hint'
  const popupHintInner = document.createElement('span')
  popupHintEl.appendChild(popupHintInner)
  row2.append(popupPathWrap, popupHintEl)

  header.append(row1, row2)

  // --- prompt -----------------------------------------------------

  const promptWrap = document.createElement('div')
  promptWrap.className = 'prompt'
  const textarea = document.createElement('textarea')
  textarea.placeholder = 'What should change?'
  textarea.rows = 3
  textarea.maxLength = 4000
  textarea.setAttribute('aria-label', 'Prompt for the agent')
  textarea.setAttribute('aria-controls', 'cmux-agents')
  textarea.setAttribute('aria-describedby', 'cmux-to')
  promptWrap.appendChild(textarea)

  // --- screenshot switch -----------------------------------------------------

  const shotRow = document.createElement('label')
  shotRow.className = 'shot-row'

  const shotCheckbox = document.createElement('input')
  shotCheckbox.type = 'checkbox'
  shotCheckbox.className = 'switch'
  shotCheckbox.setAttribute('role', 'switch')
  shotCheckbox.checked = readShotPref()
  shotCheckbox.addEventListener('change', () => writeShotPref(shotCheckbox.checked))

  const shotLabel = document.createElement('span')
  shotLabel.textContent = 'Attach screenshot'

  shotRow.append(shotCheckbox, shotLabel)

  // --- To field -----------------------------------------------------

  const toRow = document.createElement('button')
  toRow.type = 'button'
  toRow.className = 'to-row'
  toRow.id = 'cmux-to'
  toRow.setAttribute('aria-expanded', 'false')
  toRow.setAttribute('aria-controls', 'cmux-agent-groups')

  const toLabel = document.createElement('span')
  toLabel.className = 'to-label'
  toLabel.textContent = 'To'

  const toTitle = document.createElement('span')
  toTitle.className = 'to-title'
  const toName = document.createElement('span')
  toName.className = 'to-name'
  const { svg: chevronSvg, path: chevronPath } = buildChevron()
  toTitle.append(toName, chevronSvg)

  const toStatus = document.createElement('span')
  toStatus.className = 'to-status'
  const toStatusDot = document.createElement('i')
  toStatusDot.className = 'status-dot'
  const toStatusWord = document.createTextNode('')
  toStatus.append(toStatusDot, toStatusWord)

  const toBranch = document.createElement('span')
  toBranch.className = 'to-branch'
  const toPane = document.createElement('span')
  toPane.className = 'to-pane'
  const toHint = document.createElement('span')
  toHint.className = 'to-hint'

  toRow.append(toLabel, toTitle, toStatus, toBranch, toPane, toHint)

  const agentsNotice = document.createElement('div')
  agentsNotice.className = 'agents-notice'
  agentsNotice.hidden = true

  // --- agent list -----------------------------------------------------

  const agentsArea = document.createElement('div')
  agentsArea.className = 'agents-area'
  agentsArea.setAttribute('role', 'listbox')
  agentsArea.setAttribute('aria-label', 'Agents')
  agentsArea.id = 'cmux-agents'

  const agentsGroups = document.createElement('div')
  agentsGroups.className = 'agents-groups'
  agentsGroups.id = 'cmux-agent-groups'
  agentsGroups.hidden = true

  const spawnGroup = document.createElement('div')
  spawnGroup.className = 'spawn-group'
  spawnGroup.setAttribute('role', 'group')
  spawnGroup.setAttribute('aria-label', 'New agent')

  agentsArea.append(agentsGroups, spawnGroup)

  // --- footer -----------------------------------------------------

  const footer = document.createElement('div')
  footer.className = 'popup-footer'
  const keys = document.createElement('div')
  keys.className = 'keys'

  function keyHint(keycaps: string[], text: string): { wrap: HTMLElement; textNode: Text } {
    const wrap = document.createElement('span')
    for (const cap of keycaps) {
      const kbd = document.createElement('kbd')
      kbd.textContent = cap
      wrap.appendChild(kbd)
    }
    const textNode = document.createTextNode(text)
    wrap.appendChild(textNode)
    return { wrap, textNode }
  }

  const sendHint = keyHint(['↵'], 'send')
  const newlineHint = keyHint(['⇧↵'], 'newline')
  const agentHint = keyHint(['↑', '↓'], 'agent')
  const escHint = keyHint(['esc'], 'close')
  escHint.wrap.className = 'key-esc'
  keys.append(sendHint.wrap, newlineHint.wrap, agentHint.wrap, escHint.wrap)

  const sendBtn = document.createElement('button')
  sendBtn.type = 'button'
  sendBtn.className = 'send-btn'
  sendBtn.textContent = 'Send'
  footer.append(keys, sendBtn)

  popup.append(header, promptWrap, shotRow, toRow, agentsNotice, agentsArea, footer)

  const toast = document.createElement('div')
  toast.className = 'toast'
  toast.setAttribute('role', 'status')
  toast.setAttribute('aria-live', 'polite')

  shadow.append(outline, chip, inflightBox, inflightChip, popup, toast)

  // --- mutable UI state -------------------------------------------------

  let mode: Mode = 'idle'
  let hoveredEl: Element | null = null
  let pickedEl: Element | null = null
  let pickedInfo: ElementInfo | null = null
  let selection: Element[] = []
  let extrasInfo: ElementInfo[] = []
  let multiBoxes: HTMLDivElement[] = []
  let lastPointerX = 0
  let lastPointerY = 0
  let prevFocus: Element | null = null
  let prevCursor = ''
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  let pickToken = 0
  let currentStateResponse: StateResponse | null = null
  let selectableAgentIds: string[] = []
  let selectedPaneId: string | null = null
  let screenshotAvailable = false
  let expanded = false
  let sendSeq = 0
  let typed = ''

  let inflightPaneId: string | null = null
  let inflightTitle: string | null = null
  let inflightEl: Element | null = null
  let inflightSettled = false
  let inflightSettleTimer: ReturnType<typeof setTimeout> | undefined
  let inflightPollTimer: ReturnType<typeof setInterval> | undefined

  // --- outline + chip -----------------------------------------------------

  function placeChip(chipEl: HTMLElement, rect: DOMRect): void {
    const c = chipEl.getBoundingClientRect()
    const left = Math.max(8, Math.min(rect.left, innerWidth - c.width - 8))
    chipEl.style.left = `${left}px`
    chipEl.style.top = rect.top <= 0 ? `${rect.bottom + 4}px` : `${rect.top - c.height - 4}px`
  }

  function drawOutlineAt(el: Element): void {
    const rect = el.getBoundingClientRect()
    outline.style.display = 'block'
    outline.style.left = `${rect.left}px`
    outline.style.top = `${rect.top}px`
    outline.style.width = `${rect.width}px`
    outline.style.height = `${rect.height}px`

    if (el === inflightEl) {
      chip.style.display = 'none'
      return
    }

    const hint = sourceHint(el)
    const label = elementLabel(el)
    const b = document.createElement('b')
    b.textContent = label
    const nodes: Node[] = [b]
    if (hint !== null) {
      const i = document.createElement('i')
      i.textContent = '·'
      const hintSpan = document.createElement('span')
      hintSpan.textContent = truncateStart(stripHintSuffix(hint), 60)
      nodes.push(i, hintSpan)
    }
    chip.replaceChildren(...nodes)
    chip.style.display = 'flex'
    placeChip(chip, rect)
  }

  function clearOutline(): void {
    outline.style.display = 'none'
    chip.style.display = 'none'
  }

  function updateHover(x: number, y: number): void {
    const el = deepElementFromPoint(x, y, host)
    if (el === hoveredEl) return
    hoveredEl = el
    if (el === null) {
      clearOutline()
      return
    }
    drawOutlineAt(el)
  }

  // --- multi-selection outlines -----------------------------------------------

  function positionMultiBoxes(): void {
    for (const [i, box] of multiBoxes.entries()) {
      const el = selection[i]
      if (el === undefined || !el.isConnected) {
        box.style.display = 'none'
        continue
      }
      const rect = el.getBoundingClientRect()
      box.style.display = 'block'
      box.style.left = `${rect.left}px`
      box.style.top = `${rect.top}px`
      box.style.width = `${rect.width}px`
      box.style.height = `${rect.height}px`
    }
  }

  function renderMultiBoxes(): void {
    for (const box of multiBoxes) box.remove()
    multiBoxes = selection.map((_el, i) => {
      const box = document.createElement('div')
      box.className = 'multi'
      box.setAttribute('aria-hidden', 'true')
      const badge = document.createElement('span')
      badge.className = 'multi-badge'
      badge.textContent = String(i + 1)
      box.appendChild(badge)
      shadow.insertBefore(box, inflightBox)
      return box
    })
    positionMultiBoxes()
  }

  function clearSelection(): void {
    selection = []
    for (const box of multiBoxes) box.remove()
    multiBoxes = []
  }

  function addToSelection(el: Element): void {
    if (selection.includes(el)) return
    if (selection.length >= MAX_SELECTION) {
      showToast('Up to 5 elements')
      return
    }
    selection.push(el)
    renderMultiBoxes()
  }

  // --- in-flight outline -------------------------------------------------------

  function inflightLabel(): string {
    return inflightTitle ?? inflightPaneId ?? ''
  }

  function renderInflightChip(suffix: 'working' | 'sending' = 'working'): void {
    const b = document.createElement('b')
    b.textContent = inflightLabel()
    const i = document.createElement('i')
    i.textContent = '·'
    inflightChip.replaceChildren(b, i, document.createTextNode(suffix))
  }

  function positionInflight(): void {
    if (inflightEl === null) return
    if (!inflightEl.isConnected) {
      clearInflight()
      return
    }
    const rect = inflightEl.getBoundingClientRect()
    inflightBox.style.left = `${rect.left}px`
    inflightBox.style.top = `${rect.top}px`
    inflightBox.style.width = `${rect.width}px`
    inflightBox.style.height = `${rect.height}px`

    placeChip(inflightChip, rect)
  }

  function stopInflightPoll(): void {
    if (inflightPollTimer === undefined) return
    clearInterval(inflightPollTimer)
    inflightPollTimer = undefined
  }

  function clearInflight(): void {
    inflightPaneId = null
    inflightTitle = null
    inflightEl = null
    inflightSettled = false
    inflightBox.style.display = 'none'
    inflightBox.classList.remove('done', 'blocked')
    inflightChip.style.display = 'none'
    inflightChip.classList.remove('done', 'blocked')
    if (inflightSettleTimer !== undefined) {
      clearTimeout(inflightSettleTimer)
      inflightSettleTimer = undefined
    }
    stopInflightPoll()
  }

  function settleInflightFinished(): void {
    inflightSettled = true
    const label = inflightLabel()
    inflightBox.classList.add('done')
    inflightChip.classList.add('done')
    const b = document.createElement('b')
    b.textContent = 'DONE'
    const i = document.createElement('i')
    i.textContent = '·'
    const labelSpan = document.createElement('span')
    labelSpan.textContent = label
    inflightChip.replaceChildren(buildCheckIcon(), b, i, labelSpan)
    positionInflight()
    stopInflightPoll()
    if (inflightSettleTimer !== undefined) clearTimeout(inflightSettleTimer)
    inflightSettleTimer = setTimeout(() => {
      showToast(`✓ DONE · ${label}`)
      clearInflight()
    }, 3000)
  }

  function settleInflightBlocked(): void {
    inflightSettled = true
    const label = inflightLabel()
    inflightBox.classList.add('blocked')
    inflightChip.classList.add('blocked')
    const b = document.createElement('b')
    b.textContent = label
    const i = document.createElement('i')
    i.textContent = '·'
    inflightChip.replaceChildren(b, i, document.createTextNode('blocked'))
    positionInflight()
    stopInflightPoll()
    showToast(`${label} is waiting for you in cmux`)
    if (inflightSettleTimer !== undefined) clearTimeout(inflightSettleTimer)
    inflightSettleTimer = setTimeout(() => clearInflight(), 3000)
  }

  // Polling is the only status path here: the host has no push channel, so the
  // in-flight outline derives working -> settled from the state every 2 s
  function startInflightPoll(paneId: string): void {
    const startedAt = Date.now()
    let sawWorking = false

    inflightPollTimer = setInterval(() => {
      if (inflightPaneId !== paneId) {
        stopInflightPoll()
        return
      }
      // Give up rather than leave the outline painted forever: a target cmux never
      // reports as working (a plain shell, or an agent still at its trust prompt)
      // would otherwise keep the dashed box and chip over the element until reload.
      if (Date.now() - startedAt > INFLIGHT_MAX_MS) {
        stopInflightPoll()
        clearInflight()
        return
      }
      void (async () => {
        try {
          const data = await relay.state()
          if (inflightPaneId !== paneId || !data.cmux) return
          const row = data.agents.find((a) => a.pane_id === paneId)
          if (row === undefined) return
          if (row.title !== null) inflightTitle = row.title

          if (row.agent_status === 'working') {
            sawWorking = true
            renderInflightChip()
            return
          }
          const settled = row.agent_status === 'idle' || row.agent_status === 'done' || row.agent_status === 'blocked'
          if (!settled || (!sawWorking && Date.now() - startedAt < INFLIGHT_STALE_GRACE_MS)) return

          if (row.agent_status === 'blocked') settleInflightBlocked()
          else settleInflightFinished()
        } catch {
          // network hiccup: try again next tick
        }
      })()
    }, 2000)
  }

  function startInflight(paneId: string, title: string | null, el: Element, chipSuffix: 'working' | 'sending' = 'working'): void {
    stopInflightPoll()
    if (inflightSettleTimer !== undefined) {
      clearTimeout(inflightSettleTimer)
      inflightSettleTimer = undefined
    }
    inflightPaneId = paneId
    inflightTitle = title
    inflightEl = el
    inflightSettled = false
    inflightBox.classList.remove('done', 'blocked')
    inflightChip.classList.remove('done', 'blocked')
    inflightBox.style.display = 'block'
    renderInflightChip(chipSuffix)
    inflightChip.style.display = 'flex'
    positionInflight()
    startInflightPoll(paneId)
  }

  // --- mode transitions -------------------------------------------------------

  function restoreCursor(): void {
    document.documentElement.style.cursor = prevCursor
  }

  function enterPicking(): void {
    mode = 'picking'
    prevCursor = document.documentElement.style.cursor
    document.documentElement.style.cursor = 'crosshair'
  }

  function exitPicking(): void {
    mode = 'idle'
    restoreCursor()
    clearOutline()
    hoveredEl = null
    clearSelection()
  }

  function close(): void {
    popup.style.display = 'none'
    resetSending()
    clearOutline()
    hoveredEl = null
    pickedEl = null
    pickedInfo = null
    extrasInfo = []
    clearSelection()
    restoreCursor()
    if (prevFocus instanceof HTMLElement) prevFocus.focus()
    prevFocus = null
    mode = 'idle'
    sendSeq += 1
  }

  // --- toast ---------------------------------------------------------------

  const reduceMotion = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
  function animateIn(el: HTMLElement): void {
    if ((reduceMotion?.matches ?? true) || typeof el.animate !== 'function') return
    el.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 120, easing: 'cubic-bezier(0.2, 0, 0, 1)' })
  }

  function showToast(message: string, isError = false): void {
    toast.textContent = message
    toast.classList.toggle('error', isError)
    toast.style.display = 'block'
    animateIn(toast)
    if (toastTimer !== undefined) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      toast.style.display = 'none'
    }, isError ? 4500 : 3000)
  }

  function flashInvalid(): void {
    textarea.classList.add('invalid')
    setTimeout(() => textarea.classList.remove('invalid'), 400)
  }

  // --- clipboard fallback -------------------------------------------------------

  async function copyText(text: string): Promise<void> {
    if (navigator.clipboard?.writeText !== undefined) {
      try {
        await navigator.clipboard.writeText(text)
        return
      } catch {
        // fall through to the execCommand fallback below
      }
    }
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position: fixed; opacity: 0;'
    shadow.appendChild(ta)
    ta.focus()
    ta.select()
    document.execCommand('copy')
    shadow.removeChild(ta)
  }

  // --- To field + notice -------------------------------------------------------

  function showAgentsNotice(text: string): void {
    agentsNotice.textContent = text
    agentsNotice.title = text
    agentsNotice.hidden = false
    toRow.hidden = true
    clampPopup()
  }

  function showAgentsLoading(): void {
    showAgentsNotice('loading agents...')
  }

  function hideAgentsNotice(): void {
    agentsNotice.hidden = true
    toRow.hidden = false
  }

  function renderTo(): void {
    toRow.classList.remove('spawn', 'empty')
    const devLabel = currentStateResponse !== null && currentStateResponse.cmux ? devWorkspaceLabel(currentStateResponse) : null
    if (selectedPaneId === 'spawn:here' || selectedPaneId === 'spawn:worktree') {
      const kind = selectedPaneId === 'spawn:here' ? 'here' : 'worktree'
      toRow.classList.add('spawn')
      toName.textContent = kind === 'here' ? '+ agent here' : '+ agent in worktree'
      toHint.textContent = spawnHint(kind, devLabel)
      return
    }

    const agent =
      selectedPaneId !== null && currentStateResponse !== null && currentStateResponse.cmux
        ? currentStateResponse.agents.find((a) => a.pane_id === selectedPaneId)
        : undefined

    if (agent !== undefined) {
      toName.textContent = agent.title ?? `${agent.agent ?? 'agent'} ${agent.pane_id}`
      toStatusDot.className = `status-dot status-${agent.agent_status}`
      toStatusWord.textContent = agent.agent_status
      toBranch.textContent = agent.branch ?? ''
      toBranch.title = agent.branch ?? ''
      toPane.textContent = agent.pane_id
      return
    }

    toRow.classList.add('empty')
    toName.textContent = 'choose an agent'
    toStatusDot.className = 'status-dot'
    toStatusWord.textContent = ''
    toBranch.textContent = ''
    toBranch.title = ''
    toPane.textContent = ''
  }

  // --- expand/collapse -------------------------------------------------------

  function clampPopup(): void {
    if (popup.style.display === 'none') return
    const r = popup.getBoundingClientRect()
    popup.style.left = `${Math.max(8, Math.min(r.left, innerWidth - r.width - 8))}px`
    popup.style.top = `${Math.max(8, Math.min(r.top, innerHeight - r.height - 8))}px`
  }

  function setExpanded(next: boolean): void {
    if (next && agentsGroups.childElementCount === 0) return
    expanded = next
    agentsGroups.hidden = !next
    toRow.setAttribute('aria-expanded', String(next))
    chevronPath.setAttribute('d', next ? CHEVRON_UP : CHEVRON_DOWN)
    clampPopup()
  }

  toRow.addEventListener('click', () => setExpanded(!expanded))

  // --- agents list -----------------------------------------------------------

  function updateSelection(): void {
    const rows = agentsArea.querySelectorAll<HTMLElement>('.agent-row')
    for (const row of rows) {
      const isSelected = row.dataset.paneId === selectedPaneId
      row.setAttribute('aria-selected', String(isSelected))
      if (isSelected && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' })
    }
    if (selectedPaneId === null) textarea.removeAttribute('aria-activedescendant')
    else textarea.setAttribute('aria-activedescendant', rowId(selectedPaneId))
    renderTo()
  }

  function disableRows(): void {
    for (const row of agentsArea.querySelectorAll<HTMLElement>('.agent-row')) {
      row.setAttribute('aria-disabled', 'true')
      row.classList.add('busy')
    }
  }

  function renderAgentRow(agent: AgentRow): HTMLElement {
    const row = document.createElement('div')
    row.className = 'agent-row'
    row.setAttribute('role', 'option')
    row.id = rowId(agent.pane_id)
    row.dataset.paneId = agent.pane_id

    const blocked = agent.agent_status === 'blocked'
    if (blocked) {
      row.classList.add('blocked')
      row.setAttribute('aria-disabled', 'true')
      row.title = 'Waiting for you in cmux, answer it there first'
    }

    const title = document.createElement('span')
    title.className = 'agent-title'
    title.textContent = agent.title ?? `${agent.agent ?? 'agent'} ${agent.pane_id}`

    const status = document.createElement('span')
    status.className = 'agent-status'
    const dot = document.createElement('i')
    dot.className = `status-dot status-${agent.agent_status}`
    status.append(dot, document.createTextNode(agent.agent_status))

    const branch = document.createElement('span')
    branch.className = 'agent-branch'
    branch.textContent = agent.branch ?? ''
    branch.title = agent.branch ?? ''

    const pane = document.createElement('span')
    pane.className = 'agent-pane'
    pane.textContent = agent.pane_id

    row.append(title, status, branch, pane)

    row.addEventListener('click', () => {
      if (blocked) return
      selectedPaneId = agent.pane_id
      updateSelection()
    })

    return row
  }

  function renderSpawnRow(kind: 'here' | 'worktree', devLabel: string | null): HTMLElement {
    const paneId = kind === 'here' ? 'spawn:here' : 'spawn:worktree'
    const row = document.createElement('div')
    row.className = 'agent-row spawn-row'
    row.setAttribute('role', 'option')
    row.id = rowId(paneId)
    row.dataset.paneId = paneId

    const title = document.createElement('span')
    title.className = 'agent-title'
    title.textContent = kind === 'here' ? '+ agent here' : '+ agent in worktree'

    const hint = document.createElement('span')
    hint.className = 'spawn-hint'
    hint.textContent = spawnHint(kind, devLabel)

    row.title =
      kind === 'here'
        ? devLabel !== null
          ? `Split a pane next to the focused pane, in ${devLabel}`
          : 'Split a pane next to the focused pane'
        : 'Create a fresh cmux worktree workspace and start an agent there'

    row.append(title, hint)

    row.addEventListener('click', () => {
      selectedPaneId = paneId
      updateSelection()
    })

    return row
  }

  function renderAgents(state: StateResponse): void {
    currentStateResponse = state
    screenshotAvailable = state.cmux && state.screenshot === 'available'
    shotRow.style.display = screenshotAvailable ? 'flex' : 'none'
    agentsGroups.innerHTML = ''
    spawnGroup.innerHTML = ''
    agentsArea.hidden = !state.cmux

    if (mode !== 'sending') sendBtn.textContent = state.cmux ? 'Send' : 'Copy'
    sendHint.textNode.textContent = state.cmux ? 'send' : 'copy'

    if (!state.cmux) {
      selectableAgentIds = []
      selectedPaneId = null
      showAgentsNotice(unreachableNotice(state.reason))
      updateSelection()
      clampPopup()
      return
    }

    const groups = groupAgents(state)
    selectableAgentIds = [...selectableIds(groups), 'spawn:here', 'spawn:worktree']
    selectedPaneId = pickAgent(state, readLast())
    const devLabel = devWorkspaceLabel(state)

    for (const group of groups) {
      const wsLabel = group.workspace.label ?? group.workspace.workspace_id
      const groupLabel = group.workspace.focused ? `${wsLabel} · focused` : wsLabel
      const groupEl = document.createElement('div')
      groupEl.setAttribute('role', 'group')
      groupEl.setAttribute('aria-label', groupLabel)
      const heading = document.createElement('div')
      heading.className = 'agents-group-heading'
      heading.setAttribute('aria-hidden', 'true')
      heading.textContent = wsLabel
      if (group.workspace.focused) {
        const pill = document.createElement('span')
        pill.className = 'focused-pill'
        pill.textContent = 'focused'
        heading.appendChild(pill)
      }
      groupEl.appendChild(heading)

      for (const agent of group.agents) groupEl.appendChild(renderAgentRow(agent))
      agentsGroups.appendChild(groupEl)
    }

    spawnGroup.append(renderSpawnRow('here', devLabel), renderSpawnRow('worktree', devLabel))

    hideAgentsNotice()
    updateSelection()
    clampPopup()
  }

  async function loadAgents(token: number): Promise<void> {
    showAgentsLoading()
    try {
      const data = await relay.state()
      if (token !== pickToken) return
      renderAgents(data)
    } catch {
      if (token !== pickToken) return
      renderAgents({ cmux: false, reason: 'network_error', message: 'could not reach cmux' })
    }
  }

  async function requestSpawn(mode: 'here' | 'worktree'): Promise<SpawnResponse | null> {
    disableRows()
    showAgentsNotice('starting agent…')

    try {
      const res = await relay.spawn({ mode })

      if (res.status === 200) {
        const data = res.body as SpawnResponse
        pickToken += 1
        await loadAgents(pickToken)
        return data
      }

      const err = res.body as ErrorResponse
      showToast(err.message, true)
      pickToken += 1
      await loadAgents(pickToken)
      return null
    } catch {
      showToast('could not reach cmux', true)
      pickToken += 1
      await loadAgents(pickToken)
      return null
    }
  }

  function moveSelection(delta: number): void {
    if (selectableAgentIds.length === 0) return
    if (!expanded && agentsGroups.childElementCount > 0) {
      setExpanded(true)
      return
    }
    const idx = selectedPaneId !== null ? selectableAgentIds.indexOf(selectedPaneId) : -1
    const base = idx === -1 ? (delta > 0 ? -1 : selectableAgentIds.length) : idx
    const nextIdx = Math.max(0, Math.min(selectableAgentIds.length - 1, base + delta))
    selectedPaneId = selectableAgentIds[nextIdx] ?? null
    updateSelection()
  }

  // --- popup positioning + open/pick ------------------------------------------

  function cycleFocus(delta: number): void {
    const items = [...popup.querySelectorAll<HTMLElement>('button, input, textarea')].filter(
      (el) => el.getClientRects().length > 0 && !(el as HTMLButtonElement).disabled,
    )
    if (items.length === 0) return
    const active = shadow.activeElement
    const idx = active instanceof HTMLElement ? items.indexOf(active) : -1
    const next = idx === -1 ? (delta > 0 ? 0 : items.length - 1) : (idx + delta + items.length) % items.length
    items[next]?.focus()
  }

  function positionPopup(x: number, y: number): void {
    const r = popup.getBoundingClientRect()
    let left = x + 12
    if (left + r.width > innerWidth - 8) left = x - 12 - r.width
    left = Math.max(8, Math.min(left, innerWidth - r.width - 8))

    let top = y + 12
    if (top + r.height > innerHeight - 8) top = y - 12 - r.height
    top = Math.max(8, Math.min(top, innerHeight - r.height - 8))

    popup.style.left = `${left}px`
    popup.style.top = `${top}px`
  }

  function openPopup(x: number, y: number): void {
    if (pickedEl === null || pickedInfo === null) return

    const total = 1 + extrasInfo.length
    countEl.textContent = total > 1 ? `${total} elements` : ''
    countEl.style.display = total > 1 ? '' : 'none'

    labelEl.textContent = elementLabel(pickedEl)

    const pathLabel = popupPathLabel(pickedInfo.path)
    popupPathInner.textContent = pathLabel ?? ''
    popupPathWrap.title = pickedInfo.path
    popupPathWrap.style.display = pathLabel !== null ? '' : 'none'

    const strippedHint = pickedInfo.hint !== null ? stripHintSuffix(pickedInfo.hint) : null
    popupHintInner.textContent = strippedHint ?? ''
    popupHintEl.title = pickedInfo.hint ?? ''
    popupHintEl.style.display = strippedHint !== null ? '' : 'none'

    row2.style.display = pathLabel !== null || strippedHint !== null ? '' : 'none'

    textarea.value = ''
    typed = ''
    currentStateResponse = null
    selectedPaneId = null
    screenshotAvailable = false
    shotRow.style.display = 'none'
    setExpanded(false)

    popup.style.display = 'flex'
    positionPopup(x, y)
    animateIn(popup)
    textarea.focus()

    pickToken += 1
    void loadAgents(pickToken)
  }

  function pick(el: Element, x: number, y: number): void {
    if (selection.length > 0) {
      if (selection.length < MAX_SELECTION && !selection.includes(el)) selection.push(el)
      renderMultiBoxes()
    }
    const combined = selection.length > 0 ? selection : [el]
    const primary = combined[0] ?? el
    const extraEls = combined.slice(1)

    const describeOpts = { maxDepth: MAX_DEPTH, maxLines: MAX_LINES }
    pickedEl = primary
    pickedInfo = describeElement(primary, describeOpts)
    extrasInfo = extraEls.map((e) => describeElement(e, describeOpts))

    prevFocus = document.activeElement
    drawOutlineAt(el)
    restoreCursor()
    mode = 'popup'
    openPopup(x, y)
  }

  // --- send -------------------------------------------------------------------

  function findSession(paneId: string): string | null {
    if (currentStateResponse === null || !currentStateResponse.cmux) return null
    return currentStateResponse.agents.find((a) => a.pane_id === paneId)?.session ?? null
  }

  function findTitle(paneId: string): string | null {
    if (currentStateResponse === null || !currentStateResponse.cmux) return null
    return currentStateResponse.agents.find((a) => a.pane_id === paneId)?.title ?? null
  }

  function nextFrame(): Promise<void> {
    return new Promise((r) => requestAnimationFrame(() => r()))
  }

  async function send(): Promise<void> {
    const prompt = typed.trim()
    if (prompt.length === 0) {
      flashInvalid()
      return
    }
    if (pickedInfo === null || pickedEl === null) return
    const info = pickedInfo
    const el = pickedEl
    const extras = extrasInfo

    const clipboardMode = currentStateResponse === null || currentStateResponse.cmux === false
    if (clipboardMode) {
      await copyText(composePrompt(info, prompt, { extras }))
      showToast('Prompt copied to clipboard')
      close()
      return
    }

    if (selectedPaneId === null) {
      flashInvalid()
      return
    }

    let target = selectedPaneId
    const seq = ++sendSeq
    mode = 'sending'
    popup.classList.add('sending')
    sendBtn.disabled = true
    sendBtn.textContent = 'Sending…'

    if (target.startsWith('spawn:')) {
      const spawnMode = target === 'spawn:here' ? 'here' : 'worktree'
      const data = await requestSpawn(spawnMode)
      if (seq !== sendSeq || mode !== 'sending') return
      if (data === null) {
        reopenAfterError()
        return
      }
      selectedPaneId = data.pane_id
      updateSelection()
      target = data.pane_id
    }

    const wantsShot = screenshotAvailable && shotCheckbox.checked && document.visibilityState === 'visible'
    let screenshotPng: string | undefined

    if (wantsShot) {
      popup.style.display = 'none'
      if (outline.style.display !== 'block') drawOutlineAt(el)
      await nextFrame()
      await nextFrame()
      if (seq !== sendSeq || mode !== 'sending') return

      const r = el.getBoundingClientRect()
      try {
        screenshotPng = await relay.capture({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })
      } catch {
        screenshotPng = undefined
      }
      if (seq !== sendSeq || mode !== 'sending') return
    }

    const body: PromptRequest = {
      target,
      prompt,
      element: info,
      ...(extras.length > 0 ? { extras } : {}),
      ...(screenshotPng !== undefined ? { screenshotPng } : {}),
    }

    startInflight(target, findTitle(target), el, 'sending')

    try {
      const res = await relay.prompt(body)

      if (res.status === 200) {
        const data = res.body as PromptResponse

        if (!data.submitted) {
          // Pasted into the agent's prompt but not submitted: no settle state will ever arrive
          // for it, and sending again would paste the text a second time on top of the first.
          if (inflightPaneId === target) clearInflight()
          writeLast({ pane_id: target, session: findSession(target) })
          const reasonSuffix = data.submit_error !== null ? ` (${data.submit_error})` : ''
          showToast(`Waiting at the prompt in cmux, press Enter there to send it${reasonSuffix}`, true)
          close()
          return
        }

        const sentPaneId = data.pane_id ?? target
        const stillTracking = inflightPaneId === target
        if (stillTracking && !inflightSettled) renderInflightChip()
        if (!(stillTracking && inflightSettled)) showToast(`Sent to ${data.title ?? data.target}`)
        writeLast({ pane_id: target, session: findSession(target) })
        close()
        if (sentPaneId !== target && stillTracking && !inflightSettled) startInflight(sentPaneId, data.title, el)
        return
      }

      if (inflightPaneId === target) clearInflight()

      if (res.status === 409) {
        showToast('Agent is not available in cmux right now, try again', true)
        reopenAfterError()
        return
      }

      if (res.status === 404) {
        showToast('Agent is gone', true)
        reopenAfterError()
        pickToken += 1
        void loadAgents(pickToken)
        return
      }

      if (res.status === 400 || res.status === 413 || res.status === 415) {
        const err = res.body as ErrorResponse
        showToast(err.message, true)
        reopenAfterError()
        return
      }

      await copyText(composePrompt(info, prompt, { extras }))
      showToast('cmux unreachable, prompt copied to clipboard', true)
      close()
    } catch {
      if (inflightPaneId === target) clearInflight()
      await copyText(composePrompt(info, prompt, { extras }))
      showToast('cmux unreachable, prompt copied to clipboard', true)
      close()
    }
  }

  function resetSending(): void {
    popup.classList.remove('sending')
    sendBtn.disabled = false
    sendBtn.textContent = currentStateResponse !== null && currentStateResponse.cmux === false ? 'Copy' : 'Send'
  }

  function reopenAfterError(): void {
    mode = 'popup'
    resetSending()
    popup.style.display = 'flex'
    textarea.focus()
  }

  sendBtn.addEventListener('click', (e) => {
    if (!e.isTrusted) return
    if (mode === 'popup') void send()
  })

  // --- window listeners (capture phase) ----------------------------------------

  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted) return
      if (mode === 'idle') return

      if (mode === 'picking') {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          exitPicking()
        }
        return
      }

      // popup or sending
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        if (mode === 'popup') cycleFocus(e.shiftKey ? -1 : 1)
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.stopPropagation()
        if (e.composedPath()[0] instanceof HTMLButtonElement) return
        e.preventDefault()
        if (mode === 'popup') void send()
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        if (mode === 'popup') moveSelection(-1)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        if (mode === 'popup') moveSelection(1)
        return
      }
      e.stopPropagation()
    },
    true,
  )

  window.addEventListener(
    'pointermove',
    (e) => {
      if (mode !== 'picking') return
      lastPointerX = e.clientX
      lastPointerY = e.clientY
      updateHover(e.clientX, e.clientY)
    },
    true,
  )

  function refreshHover(): void {
    if (mode !== 'picking') return
    hoveredEl = null
    updateHover(lastPointerX, lastPointerY)
  }

  function onScrollOrResize(): void {
    refreshHover()
    if ((mode === 'popup' || mode === 'sending') && pickedEl !== null) drawOutlineAt(pickedEl)
    clampPopup()
    positionInflight()
    positionMultiBoxes()
  }

  window.addEventListener('scroll', onScrollOrResize, true)
  window.addEventListener('resize', onScrollOrResize, true)

  function blockInPicking(e: Event): void {
    if (mode !== 'picking') return
    e.preventDefault()
    e.stopPropagation()
  }

  window.addEventListener('pointerdown', blockInPicking, true)
  window.addEventListener('mousedown', blockInPicking, true)
  window.addEventListener('mouseup', blockInPicking, true)

  window.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return
      if (mode !== 'picking') return
      e.preventDefault()
      e.stopPropagation()
      const el = deepElementFromPoint(e.clientX, e.clientY, host)
      if (el === null) return

      if (e.shiftKey) {
        addToSelection(el)
        return
      }

      pick(el, e.clientX, e.clientY)
    },
    true,
  )

  textarea.addEventListener('input', (e) => {
    if (!e.isTrusted) return
    typed = textarea.value
  })

  // --- public debug/bench API -------------------------------------------------

  window.__cmux = {
    version: 'dev',
    describe: (el) => describeElement(el, { maxDepth: MAX_DEPTH, maxLines: MAX_LINES }),
    outline: (el) => {
      if (el === null) {
        clearOutline()
        return
      }
      drawOutlineAt(el)
    },
    pick: (el, x, y) => pick(el, x, y),
    close: () => close(),
    inflight: () => inflightPaneId,
    screenshotEnabled: () => shotCheckbox.checked,
    selection: () => selection.map((el) => selectorPath(el)),
    start: () => {
      if (mode === 'idle') enterPicking()
      else if (mode === 'picking') exitPicking()
    },
  }
}
