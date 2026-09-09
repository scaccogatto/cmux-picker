import type { ElementInfo } from '../types.ts'

/** Attribute added (in serialized output only) to mark the picked node */
export const PICKED_ATTR = 'data-cmux-picked'
/** Attribute carried by the picker's own overlay host, used to exclude it from hit-testing and snippets */
export const HOST_ATTR = 'data-cmux-host'

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Hit-test through shadow DOM boundaries, excluding the picker's own overlay host */
export function deepElementFromPoint(x: number, y: number, host: Element | null): Element | null {
  let el = document.elementFromPoint(x, y)
  if (el === null) return null

  while (el.shadowRoot !== null) {
    const inner = el.shadowRoot.elementFromPoint(x, y)
    if (inner === null || inner === el) break
    el = inner
  }

  if (host !== null && (el === host || host.contains(el))) return null

  if (el.namespaceURI === SVG_NS && el.tagName.toLowerCase() !== 'svg') {
    return el.closest('svg')
  }

  return el
}

const SOURCE_ATTRS = ['data-v-inspector', 'data-insp-path', 'data-asl', 'data-loc']

function readProp(obj: unknown, key: string): unknown {
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined
  return (obj as Record<string, unknown>)[key]
}

function vueHint(node: Element): string | null {
  const component = readProp(node, '__vueParentComponent')
  const type = readProp(component, 'type')
  const file = readProp(type, '__file')
  if (typeof file !== 'string' || file.length === 0) return null

  const rawName = readProp(type, '__name')
  const fallbackName = readProp(type, 'name')
  const name =
    typeof rawName === 'string' && rawName.length > 0
      ? rawName
      : typeof fallbackName === 'string' && fallbackName.length > 0
        ? fallbackName
        : 'anonymous'

  return `${file} (vue component ${name})`
}

function reactComponentName(startFiber: unknown): string | null {
  let fiber = startFiber
  while (typeof fiber === 'object' && fiber !== null) {
    const type = readProp(fiber, 'type')
    if (typeof type === 'function') {
      const displayName = readProp(type, 'displayName')
      const name = readProp(type, 'name')
      if (typeof displayName === 'string' && displayName.length > 0) return displayName
      if (typeof name === 'string' && name.length > 0) return name
      return null
    }
    fiber = readProp(fiber, 'return')
  }
  return null
}

function ownKeyStartingWith(node: Element, prefix: string): string | undefined {
  return Object.keys(node).find((k) => k.startsWith(prefix))
}

/** Best-effort source hint for an element: framework dev attributes, then Vue/React runtime introspection */
export function sourceHint(el: Element): string | null {
  for (let node: Element | null = el; node !== null && node !== document.body; node = node.parentElement) {
    for (const attr of SOURCE_ATTRS) {
      const value = node.getAttribute(attr)
      if (value !== null && value.length > 0) {
        return node === el ? `${value} (${attr})` : `${value} (${attr}, ancestor)`
      }
    }
  }

  // vite-plugin-vue-inspector's default cleanHtml:true strips the
  // data-v-inspector attribute after stamping it, leaving the value only on
  // the vnode's props (a non-enumerable prop set by the framework, not by us)
  for (let node: Element | null = el; node !== null && node !== document.body; node = node.parentElement) {
    const value = readProp(readProp(readProp(node, '__vnode'), 'props'), '__v_inspector')
    if (typeof value === 'string' && value.length > 0) {
      return node === el ? `${value} (data-v-inspector)` : `${value} (data-v-inspector, ancestor)`
    }
  }

  for (let node: Element | null = el; node !== null && node !== document.body; node = node.parentElement) {
    const hint = vueHint(node)
    if (hint !== null) return hint
  }

  for (let node: Element | null = el; node !== null && node !== document.body; node = node.parentElement) {
    const fiberKey = ownKeyStartingWith(node, '__reactFiber$')
    if (fiberKey !== undefined) {
      const name = reactComponentName(readProp(node, fiberKey))
      if (name !== null) return `react component ${name}, no file`
    }
  }

  return null
}

/** Strip the trailing ` (source)` / ` (source, ancestor)` parenthetical `sourceHint` appends, for display; the full hint stays available separately (e.g. in a `title` attribute) */
export function stripHintSuffix(hint: string): string {
  return hint.replace(/ \([^()]*\)$/, '')
}

/** `in a › b › c` for the ancestors of a `selectorPath` output (segments joined by ` > ` or ` >>> `), dropping the last (picked) segment; `null` when there are no ancestors */
export function popupPathLabel(path: string): string | null {
  const segments = path.split(/ > | >>> /).filter((s) => s.length > 0)
  if (segments.length <= 1) return null
  return `in ${segments.slice(0, -1).join(' › ')}`
}

/** Visible "where" text for a spawn row / the To field's spawn hint: `kind` picks the action, `devLabel` (the focused workspace label, or null when unknown) fills in the location for "here" */
export function spawnHint(kind: 'here' | 'worktree', devLabel: string | null): string {
  if (kind === 'worktree') return 'fresh worktree'
  return devLabel !== null ? `split pane in ${devLabel}` : 'split pane next to the focused pane'
}

/** Truncate from the start, keeping the tail: for text where the end matters more than the beginning (e.g. a file path's line:col, the useful half of a source hint) */
export function truncateStart(value: string, max: number): string {
  return value.length > max ? `…${value.slice(-(max - 1))}` : value
}

const ID_RE = /^[A-Za-z_][\w-]*$/
const CLASS_RE = /^[a-z_-][\w-]*$/i

/** Build a short CSS-like selector path for an element, climbing at most 6 segments */
export function selectorPath(el: Element): string {
  const segments: string[] = []
  const separators: (' > ' | ' >>> ')[] = []

  let node: Element | null = el
  while (node !== null) {
    const current: Element = node
    const tag = current.tagName.toLowerCase()
    if (tag === 'body' || tag === 'html') break

    const id = current.id
    if (id.length > 0 && ID_RE.test(id)) {
      segments.push(`${tag}#${id}`)
      break
    }

    const classAttr = current.getAttribute('class')
    const classes =
      classAttr !== null
        ? classAttr
            .split(/\s+/)
            .filter((c) => CLASS_RE.test(c))
            .slice(0, 2)
        : []

    const parent: Element | null = current.parentElement
    if (classes.length > 0) {
      segments.push(`${tag}.${classes.join('.')}`)
    } else if (parent !== null) {
      const sameTagSiblings = Array.from(parent.children).filter((c) => c.tagName === current.tagName)
      segments.push(
        sameTagSiblings.length > 1 ? `${tag}:nth-of-type(${sameTagSiblings.indexOf(current) + 1})` : tag,
      )
    } else {
      segments.push(tag)
    }

    if (parent !== null) {
      separators.push(' > ')
      node = parent
      continue
    }

    const root = current.getRootNode()
    if (root instanceof ShadowRoot) {
      separators.push(' >>> ')
      node = root.host
      continue
    }

    node = null
  }

  const capped = segments.slice(0, 6)
  const cappedSeparators = separators.slice(0, Math.max(0, capped.length - 1))

  const revSegments = [...capped].reverse()
  const revSeparators = [...cappedSeparators].reverse()

  return revSegments.reduce(
    (acc, seg, i) => (i === 0 ? seg : `${acc}${revSeparators[i - 1] ?? ' > '}${seg}`),
    '',
  )
}

const COLLAPSE_TAGS = new Set(['script', 'style', 'svg', 'canvas', 'template', 'noscript', 'video', 'audio', 'iframe'])
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])

function truncateAttr(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value
}

function truncateText(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value
}

function renderAttrs(el: Element, appendPickedMarker: boolean): string {
  const parts = Array.from(el.attributes).map((a) => `${a.name}="${truncateAttr(a.value)}"`)
  if (appendPickedMarker) parts.push(`${PICKED_ATTR}=""`)
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

function isDroppedElement(el: Element): boolean {
  if (el.getAttribute('aria-hidden') === 'true') return true
  if (el.hasAttribute('hidden')) return true
  if (el.hasAttribute(HOST_ATTR)) return true
  if (getComputedStyle(el).display === 'none') return true
  return false
}

interface TrimCtx {
  maxDepth: number
  picked: Element
  pathSet: Set<Element>
}

interface RenderResult {
  lines: string[]
  pickedLine: number
}

function renderChildNode(node: ChildNode, depth: number, ctx: TrimCtx): RenderResult | null {
  if (node instanceof Comment) return null

  if (node instanceof Text) {
    const collapsed = (node.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (collapsed.length === 0) return null
    return { lines: [`${'  '.repeat(depth)}${truncateText(collapsed)}`], pickedLine: -1 }
  }

  if (node instanceof Element) {
    if (isDroppedElement(node)) return null
    return renderElement(node, depth, ctx)
  }

  return null
}

function renderElement(el: Element, depth: number, ctx: TrimCtx): RenderResult {
  const tag = el.tagName.toLowerCase()
  const indent = '  '.repeat(depth)
  const isPicked = el === ctx.picked
  const attrs = renderAttrs(el, isPicked)

  if (COLLAPSE_TAGS.has(tag)) {
    return { lines: [`${indent}<${tag}${attrs}>...</${tag}>`], pickedLine: isPicked ? 0 : -1 }
  }

  if (VOID_TAGS.has(tag)) {
    return { lines: [`${indent}<${tag}${attrs}>`], pickedLine: isPicked ? 0 : -1 }
  }

  if (depth > ctx.maxDepth) {
    const n = el.childElementCount
    const line =
      n === 0 ? `${indent}<${tag}${attrs}></${tag}>` : `${indent}<${tag}${attrs}>...(${n} children)</${tag}>`
    return { lines: [line], pickedLine: isPicked ? 0 : -1 }
  }

  const childResults: RenderResult[] = []
  for (const child of Array.from(el.childNodes)) {
    const rendered = renderChildNode(child, depth + 1, ctx)
    if (rendered !== null) childResults.push(rendered)
  }

  const onPath = ctx.pathSet.has(el)
  const pickedChildIdx = childResults.findIndex((r) => r.pickedLine !== -1)

  const childIndent = '  '.repeat(depth + 1)
  let before: string[] = []
  let after: string[] = []
  let selected: RenderResult[]

  if (onPath && pickedChildIdx !== -1) {
    const start = Math.max(0, pickedChildIdx - 2)
    const end = Math.min(childResults.length - 1, pickedChildIdx + 2)
    if (start > 0) before = [`${childIndent}<!-- ${start} more -->`]
    if (end < childResults.length - 1) after = [`${childIndent}<!-- ${childResults.length - 1 - end} more -->`]
    selected = childResults.slice(start, end + 1)
  } else {
    selected = childResults.slice(0, 5)
    if (childResults.length > 5) after = [`${childIndent}<!-- ${childResults.length - 5} more -->`]
  }

  const lines: string[] = [`${indent}<${tag}${attrs}>`, ...before]
  let pickedLine = isPicked ? 0 : -1
  for (const r of selected) {
    if (r.pickedLine !== -1) pickedLine = lines.length + r.pickedLine
    lines.push(...r.lines)
  }
  lines.push(...after)
  lines.push(`${indent}</${tag}>`)

  return { lines, pickedLine }
}

function trimHtmlRoot(picked: Element): Element {
  const parent = picked.parentElement
  if (parent === null) return picked
  const tag = parent.tagName.toLowerCase()
  return tag === 'body' || tag === 'html' ? picked : parent
}

function buildPathSet(root: Element, picked: Element): Set<Element> {
  const set = new Set<Element>()
  let node: Element | null = picked.parentElement
  while (node !== null) {
    set.add(node)
    if (node === root) break
    node = node.parentElement
  }
  return set
}

function applyLineCap(lines: string[], pickedLine: number, maxLines: number): string[] {
  if (lines.length <= maxLines) return lines

  const pIdx = pickedLine === -1 ? 0 : pickedLine
  const half = Math.floor(maxLines / 2)
  let start = pIdx - half
  let end = start + maxLines - 1

  if (start < 0) {
    start = 0
    end = maxLines - 1
  }
  if (end > lines.length - 1) {
    end = lines.length - 1
    start = Math.max(0, end - maxLines + 1)
  }

  const result: string[] = []
  if (start > 0) result.push(`<!-- +${start} lines -->`)
  result.push(...lines.slice(start, end + 1))
  if (end < lines.length - 1) result.push(`<!-- +${lines.length - 1 - end} lines -->`)
  return result
}

/** Serialize a trimmed, indented HTML snippet around the picked element */
export function trimHtml(picked: Element, opts: { maxDepth: number; maxLines: number }): string {
  const root = trimHtmlRoot(picked)
  const pathSet = buildPathSet(root, picked)
  const ctx: TrimCtx = { maxDepth: opts.maxDepth, picked, pathSet }

  const result = renderElement(root, 0, ctx)
  return applyLineCap(result.lines, result.pickedLine, opts.maxLines).join('\n')
}

const STYLE_PROPS = [
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'font-size',
  'font-weight',
  'line-height',
  'color',
  'background-color',
  'border',
  'overflow',
  'gap',
  'z-index',
]

/** Summarize the computed styles that matter most for layout and appearance */
export function styleSummary(el: Element): Record<string, string> {
  const computed = getComputedStyle(el)
  const result: Record<string, string> = {}
  for (const prop of STYLE_PROPS) {
    const value = computed.getPropertyValue(prop)
    if (value !== '') result[prop] = value
  }
  return result
}

/** Capture everything cmux needs to know about a picked element */
export function describeElement(el: Element, opts: { maxDepth: number; maxLines: number }): ElementInfo {
  const rect = el.getBoundingClientRect()
  return {
    url: location.href,
    viewport: { w: innerWidth, h: innerHeight },
    hint: sourceHint(el),
    path: selectorPath(el),
    rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
    html: trimHtml(el, opts),
    styles: styleSummary(el),
  }
}
