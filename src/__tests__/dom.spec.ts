// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  PICKED_ATTR,
  HOST_ATTR,
  deepElementFromPoint,
  sourceHint,
  selectorPath,
  trimHtml,
  styleSummary,
  describeElement,
  stripHintSuffix,
  popupPathLabel,
  spawnHint,
  truncateStart,
} from '../extension/dom.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('deepElementFromPoint', () => {
  it('returns the element at the point for a plain hit', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    document.elementFromPoint = () => div
    expect(deepElementFromPoint(10, 10, null)).toBe(div)
  })

  it('descends through an open shadow root via its own elementFromPoint', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const inner = document.createElement('span')
    shadow.appendChild(inner)
    shadow.elementFromPoint = () => inner
    document.elementFromPoint = () => host
    expect(deepElementFromPoint(5, 5, null)).toBe(inner)
  })

  it('returns null when the hit element is the picker host or inside it', () => {
    const host = document.createElement('div')
    host.setAttribute(HOST_ATTR, '')
    const overlay = document.createElement('div')
    host.appendChild(overlay)
    document.body.appendChild(host)

    document.elementFromPoint = () => overlay
    expect(deepElementFromPoint(1, 1, host)).toBeNull()

    document.elementFromPoint = () => host
    expect(deepElementFromPoint(1, 1, host)).toBeNull()
  })

  it('returns the closest svg for an inner svg element', () => {
    const svg = document.createElementNS(SVG_NS, 'svg')
    const path = document.createElementNS(SVG_NS, 'path')
    svg.appendChild(path)
    document.body.appendChild(svg)
    document.elementFromPoint = () => path
    expect(deepElementFromPoint(1, 1, null)).toBe(svg)
  })

  it('does not descend into an iframe', () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    document.elementFromPoint = () => iframe
    expect(deepElementFromPoint(1, 1, null)).toBe(iframe)
  })

  it('returns null when nothing is hit', () => {
    document.elementFromPoint = () => null
    expect(deepElementFromPoint(1, 1, null)).toBeNull()
  })
})

describe('sourceHint', () => {
  it('prefers data-v-inspector over data-loc on the same element', () => {
    const div = document.createElement('div')
    div.setAttribute('data-loc', 'foo.js:1')
    div.setAttribute('data-v-inspector', 'foo.vue:2')
    document.body.appendChild(div)
    expect(sourceHint(div)).toBe('foo.vue:2 (data-v-inspector)')
  })

  it('adds an ancestor suffix when the hint attribute is found higher up', () => {
    const parent = document.createElement('div')
    parent.setAttribute('data-loc', 'bar.js:5')
    const child = document.createElement('span')
    parent.appendChild(child)
    document.body.appendChild(parent)
    expect(sourceHint(child)).toBe('bar.js:5 (data-loc, ancestor)')
  })

  it('reads data-v-inspector off the vnode props when cleanHtml stripped the attribute', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    ;(div as unknown as Record<string, unknown>).__vnode = {
      props: { __v_inspector: 'src/Foo.vue:3:2' },
    }
    expect(sourceHint(div)).toBe('src/Foo.vue:3:2 (data-v-inspector)')
  })

  it('adds an ancestor suffix when the vnode prop is found higher up', () => {
    const parent = document.createElement('div')
    const child = document.createElement('span')
    parent.appendChild(child)
    document.body.appendChild(parent)
    ;(parent as unknown as Record<string, unknown>).__vnode = {
      props: { __v_inspector: 'src/Bar.vue:9:1' },
    }
    expect(sourceHint(child)).toBe('src/Bar.vue:9:1 (data-v-inspector, ancestor)')
  })

  it('prefers the data-v-inspector attribute over the vnode prop when both are present', () => {
    const div = document.createElement('div')
    div.setAttribute('data-v-inspector', 'attr.vue:1:1')
    document.body.appendChild(div)
    ;(div as unknown as Record<string, unknown>).__vnode = {
      props: { __v_inspector: 'vnode.vue:2:2' },
    }
    expect(sourceHint(div)).toBe('attr.vue:1:1 (data-v-inspector)')
  })

  it('falls back to the Vue runtime component when no attribute is present', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    ;(div as unknown as Record<string, unknown>).__vueParentComponent = {
      type: { __file: 'src/Foo.vue', __name: 'Foo' },
    }
    expect(sourceHint(div)).toBe('src/Foo.vue (vue component Foo)')
  })

  it('falls back to the React fiber chain when no attribute or Vue component is present', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const MyComponent = Object.assign(() => null, { displayName: 'MyComponent' })
    ;(div as unknown as Record<string, unknown>)['__reactFiber$test'] = {
      return: { type: MyComponent, return: null },
    }
    expect(sourceHint(div)).toBe('react component MyComponent, no file')
  })

  it('returns null when nothing is found', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    expect(sourceHint(div)).toBeNull()
  })
})

describe('selectorPath', () => {
  it('stops climbing at an id and does not include ancestors above it', () => {
    const grand = document.createElement('div')
    const parent = document.createElement('section')
    parent.id = 'main-section'
    const child = document.createElement('span')
    grand.appendChild(parent)
    parent.appendChild(child)
    document.body.appendChild(grand)
    expect(selectorPath(child)).toBe('section#main-section > span')
  })

  it('renders at most two classes', () => {
    const div = document.createElement('div')
    div.setAttribute('class', 'a b c')
    document.body.appendChild(div)
    expect(selectorPath(div)).toBe('div.a.b')
  })

  it('adds nth-of-type only when siblings share the tag and there is no id or class', () => {
    const parent = document.createElement('ul')
    const li1 = document.createElement('li')
    const li2 = document.createElement('li')
    const li3 = document.createElement('li')
    parent.append(li1, li2, li3)
    document.body.appendChild(parent)
    expect(selectorPath(li2)).toBe('ul > li:nth-of-type(2)')
  })

  it('omits nth-of-type when the element is the only one with that tag', () => {
    const parent = document.createElement('div')
    const only = document.createElement('span')
    parent.appendChild(only)
    document.body.appendChild(parent)
    expect(selectorPath(only)).toBe('div > span')
  })

  it('caps the path at 6 segments, keeping the deepest ones', () => {
    const tags = ['div', 'section', 'article', 'header', 'nav', 'main', 'aside', 'footer']
    let parent: HTMLElement | null = null
    let deepest: HTMLElement | null = null
    for (const tag of tags) {
      const el = document.createElement(tag)
      if (parent === null) document.body.appendChild(el)
      else parent.appendChild(el)
      parent = el
      deepest = el
    }
    if (deepest === null) throw new Error('unreachable')
    expect(selectorPath(deepest)).toBe('article > header > nav > main > aside > footer')
  })

  it('joins across a shadow boundary with >>>', () => {
    const host = document.createElement('div')
    host.id = 'shadow-host'
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const inner = document.createElement('span')
    shadow.appendChild(inner)
    expect(selectorPath(inner)).toBe('div#shadow-host >>> span')
  })
})

describe('trimHtml', () => {
  it('marks the picked node exactly once', () => {
    const div = document.createElement('div')
    const picked = document.createElement('button')
    picked.textContent = 'Save'
    div.appendChild(picked)
    document.body.appendChild(div)

    const html = trimHtml(picked, { maxDepth: 3, maxLines: 60 })
    const occurrences = html.split(PICKED_ATTR).length - 1
    expect(occurrences).toBe(1)
    expect(html).toContain(`<button ${PICKED_ATTR}="">`)
  })

  it('drops elements hidden by style, the hidden attribute, aria-hidden, or the picker host marker', () => {
    const div = document.createElement('div')

    const byStyle = document.createElement('span')
    byStyle.setAttribute('style', 'display:none')
    byStyle.textContent = 'MARK_STYLE'

    const byHidden = document.createElement('span')
    byHidden.setAttribute('hidden', '')
    byHidden.textContent = 'MARK_HIDDEN'

    const byAria = document.createElement('span')
    byAria.setAttribute('aria-hidden', 'true')
    byAria.textContent = 'MARK_ARIA'

    const byHost = document.createElement('div')
    byHost.setAttribute(HOST_ATTR, '')
    byHost.textContent = 'MARK_HOST'

    const picked = document.createElement('button')
    picked.textContent = 'Save'

    div.append(byStyle, byHidden, byAria, byHost, picked)
    document.body.appendChild(div)

    const html = trimHtml(picked, { maxDepth: 3, maxLines: 60 })
    expect(html).not.toContain('MARK_STYLE')
    expect(html).not.toContain('MARK_HIDDEN')
    expect(html).not.toContain('MARK_ARIA')
    expect(html).not.toContain('MARK_HOST')
    expect(html).toContain('Save')
  })

  it('collapses an svg element instead of expanding its children', () => {
    const div = document.createElement('div')
    const svg = document.createElementNS(SVG_NS, 'svg')
    const path = document.createElementNS(SVG_NS, 'path')
    svg.appendChild(path)
    const picked = document.createElement('button')
    div.append(svg, picked)
    document.body.appendChild(div)

    const html = trimHtml(picked, { maxDepth: 3, maxLines: 60 })
    expect(html).toContain('<svg>...</svg>')
    expect(html).not.toContain('<path')
  })

  it('elides long attribute values to 77 chars plus an ellipsis', () => {
    const div = document.createElement('div')
    const picked = document.createElement('button')
    const longValue = 'x'.repeat(100)
    picked.setAttribute('data-long', longValue)
    div.appendChild(picked)
    document.body.appendChild(div)

    const html = trimHtml(picked, { maxDepth: 3, maxLines: 60 })
    expect(html).toContain(`data-long="${'x'.repeat(77)}..."`)
    expect(html).not.toContain(longValue)
  })

  it('elides long text nodes to 117 chars plus an ellipsis', () => {
    const div = document.createElement('div')
    const picked = document.createElement('p')
    const longText = 'y'.repeat(150)
    picked.textContent = longText
    div.appendChild(picked)
    document.body.appendChild(div)

    const html = trimHtml(picked, { maxDepth: 3, maxLines: 60 })
    expect(html).toContain(`${'y'.repeat(117)}...`)
    expect(html).not.toContain(longText)
  })

  it('collapses elements deeper than maxDepth to a child-count summary', () => {
    const root = document.createElement('div')
    const level1 = document.createElement('div')
    const level2 = document.createElement('div')
    const level3a = document.createElement('span')
    const level3b = document.createElement('span')
    level2.append(level3a, level3b)
    level1.appendChild(level2)
    const picked = document.createElement('button')
    root.append(level1, picked)
    document.body.appendChild(root)

    const html = trimHtml(picked, { maxDepth: 1, maxLines: 60 })
    expect(html).toContain('<div>...(2 children)</div>')
  })

  it('windows a 500-item child list to 2 siblings before and after the picked one', () => {
    const ul = document.createElement('ul')
    let picked: HTMLLIElement | null = null
    for (let i = 0; i < 500; i++) {
      const li = document.createElement('li')
      li.textContent = `item-${i}`
      ul.appendChild(li)
      if (i === 250) picked = li
    }
    document.body.appendChild(ul)
    if (picked === null) throw new Error('unreachable')

    const html = trimHtml(picked, { maxDepth: 3, maxLines: 5000 })
    expect(html).toContain('item-248')
    expect(html).toContain('item-249')
    expect(html).toContain('item-250')
    expect(html).toContain('item-251')
    expect(html).toContain('item-252')
    expect(html).not.toContain('item-247')
    expect(html).not.toContain('item-253')
    expect(html).toContain('<!-- 248 more -->')
    expect(html).toContain('<!-- 247 more -->')
  })

  it('caps total lines while always keeping the picked line visible', () => {
    const ul = document.createElement('ul')
    for (let i = 0; i < 3; i++) {
      const li = document.createElement('li')
      li.textContent = `filler-${i}`
      ul.appendChild(li)
    }
    const picked = document.createElement('li')
    picked.textContent = 'picked-item'
    ul.appendChild(picked)
    for (let i = 0; i < 30; i++) {
      const li = document.createElement('li')
      li.textContent = `tail-${i}`
      ul.appendChild(li)
    }
    document.body.appendChild(ul)

    const html = trimHtml(picked, { maxDepth: 3, maxLines: 10 })
    const lines = html.split('\n')
    expect(lines.length).toBeLessThanOrEqual(12)
    expect(html).toContain('picked-item')
    expect(html).toMatch(/<!-- \+\d+ lines -->/)
  })
})

describe('styleSummary', () => {
  // jsdom's getComputedStyle fills in UA-default values (display:block, position:static, ...)
  // for most of the tracked properties even with no inline style; only `overflow` and `gap`
  // stay empty absent an inline value, so those two are what exercise the non-empty filter here.
  it('surfaces inline styles for the tracked properties, preserving declaration order', () => {
    const div = document.createElement('div')
    div.setAttribute('style', 'color:red;display:flex;padding:4px;gap:8px;')
    document.body.appendChild(div)

    const styles = styleSummary(div)
    expect(styles.display).toBe('flex')
    expect(styles.padding).toBe('4px')
    expect(styles.color).toBe('rgb(255, 0, 0)')
    expect(styles.gap).toBe('8px')
    // Order follows the fixed property list, not the order they were set inline
    expect(Object.keys(styles).indexOf('display')).toBeLessThan(Object.keys(styles).indexOf('padding'))
    expect(Object.keys(styles).indexOf('padding')).toBeLessThan(Object.keys(styles).indexOf('color'))
    expect(Object.keys(styles).indexOf('color')).toBeLessThan(Object.keys(styles).indexOf('gap'))
  })

  it('omits a tracked property that has no computed value', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const styles = styleSummary(div)
    expect(styles).not.toHaveProperty('overflow')
    expect(styles).not.toHaveProperty('gap')

    div.setAttribute('style', 'overflow:hidden')
    expect(styleSummary(div).overflow).toBe('hidden')
  })
})

describe('stripHintSuffix', () => {
  it('strips a single-word parenthetical', () => {
    expect(stripHintSuffix('demo/Bench.vue:11:7 (data-v-inspector)')).toBe('demo/Bench.vue:11:7')
  })

  it('strips a parenthetical with an ancestor suffix', () => {
    expect(stripHintSuffix('demo/Bench.vue:11:7 (data-v-inspector, ancestor)')).toBe('demo/Bench.vue:11:7')
  })

  it('strips a vue-component parenthetical', () => {
    expect(stripHintSuffix('src/Foo.vue (vue component Foo)')).toBe('src/Foo.vue')
  })

  it('leaves a hint with no trailing parenthetical unchanged', () => {
    expect(stripHintSuffix('src/Foo.vue:3:1')).toBe('src/Foo.vue:3:1')
  })
})

describe('popupPathLabel', () => {
  it('joins ancestors with the display separator and drops the picked segment', () => {
    expect(popupPathLabel('main > section.task-section > button#task-label')).toBe('in main › section.task-section')
  })

  it('returns null for a single-segment path (no ancestors)', () => {
    expect(popupPathLabel('button#task-label')).toBeNull()
  })

  it('normalizes a shadow-crossing separator to the same display separator', () => {
    expect(popupPathLabel('div.host >>> section >>> button#task-label')).toBe('in div.host › section')
  })
})

describe('spawnHint', () => {
  it('names the focused workspace for "here" when its label is known', () => {
    expect(spawnHint('here', 'app')).toBe('split pane in app')
  })

  it('falls back to a generic hint for "here" when the label is unknown', () => {
    expect(spawnHint('here', null)).toBe('split pane next to the focused pane')
  })

  it('always reads "fresh worktree" for "worktree", label or not', () => {
    expect(spawnHint('worktree', 'app')).toBe('fresh worktree')
    expect(spawnHint('worktree', null)).toBe('fresh worktree')
  })
})

describe('truncateStart', () => {
  it('leaves a short value unchanged', () => {
    expect(truncateStart('demo/Bench.vue:17:7', 60)).toBe('demo/Bench.vue:17:7')
  })

  it('truncates a long value from the start, keeping the tail intact', () => {
    const long = '../../../../../../../Users/gatto/Developer/scaccogatto/vite-plugin-cmux/demo/Bench.vue:17:7'
    const result = truncateStart(long, 60)
    expect(result.length).toBe(60)
    expect(result.startsWith('…')).toBe(true)
    expect(result.endsWith('Bench.vue:17:7')).toBe(true)
  })
})

describe('describeElement', () => {
  it('captures the expected shape and rounds the bounding rect', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    div.getBoundingClientRect = () => ({
      x: 10.4,
      y: 20.6,
      width: 100.2,
      height: 50.7,
      left: 10.4,
      top: 20.6,
      right: 110.6,
      bottom: 71.3,
      toJSON() {
        return {}
      },
    })

    const info = describeElement(div, { maxDepth: 3, maxLines: 60 })
    expect(info.rect).toEqual({ x: 10, y: 21, w: 100, h: 51 })
    expect(info.url).toBe(location.href)
    expect(info.viewport).toEqual({ w: innerWidth, h: innerHeight })
    expect(info.path).toBe(selectorPath(div))
    expect(info.hint).toBeNull()
    expect(typeof info.html).toBe('string')
    expect(info.styles.display).toBe('block')
    expect(info.styles).not.toHaveProperty('gap')
  })
})
