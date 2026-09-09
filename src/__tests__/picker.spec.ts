// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import type { StateResponse, PromptResponse, SpawnResponse } from '../types.ts'
import type { Relay, RelayReply } from '../extension/picker.ts'
import { mount } from '../extension/picker.ts'

const fakeRelay = (): { relay: Relay; calls: Record<string, number | unknown[]> } => {
  const calls = { state: 0, prompt: [] as unknown[], spawn: 0, capture: 0 }
  const relay: Relay = {
    state: async () => {
      calls.state++
      return {
        cmux: true,
        version: '0.8.2',
        protocol: 20,
        workspaceId: 'w1',
        paneId: 'w1:p1',
        workspaces: [{ workspace_id: 'w1', label: 'app', number: 1, focused: true }],
        agents: [
          { pane_id: 'w1:p2', workspace_id: 'w1', agent_status: 'idle', agent: 'claude', title: 'Settings polish', branch: 'main', session: 's1', focused: false, cwd: null },
          { pane_id: 'w1:p3', workspace_id: 'w1', agent_status: 'working', agent: 'claude', title: 'Long task', branch: 'main', session: 's2', focused: false, cwd: null },
        ],
        screenshot: 'available',
      } as StateResponse
    },
    prompt: async (body: unknown) => {
      calls.prompt.push(body)
      const { target } = body as { target: string }
      return { status: 200, body: { ok: true, target, title: 'Settings polish', pane_id: target, screenshot: null } } as RelayReply<PromptResponse>
    },
    spawn: async () => {
      calls.spawn++
      return { status: 200, body: { ok: true, pane_id: 'w1:p9', name: 'pick-1', workspace_id: 'w1' } } as RelayReply<SpawnResponse>
    },
    capture: async () => {
      calls.capture++
      return 'iVBORw0KGgo='
    },
  }
  return { relay, calls }
}

beforeEach(() => {
  document.body.innerHTML = ''
  document.querySelector('[data-cmux-host]')?.remove()
  delete window.__cmux
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {}
  }
  if (!Element.prototype.animate) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Element.prototype as any).animate = () => ({ cancel: () => {} })
  }
  const btn = document.createElement('button')
  btn.id = 'target'
  btn.textContent = 'Save'
  document.body.appendChild(btn)
})

describe('picker.mount', () => {
  it('appends [data-cmux-host] with shadowRoot and defines window.__cmux', () => {
    const { relay } = fakeRelay()
    mount(relay)
    expect(document.querySelector('[data-cmux-host]')).not.toBeNull()
    expect(document.querySelector('[data-cmux-host]')?.shadowRoot).not.toBeNull()
    expect(window.__cmux?.start).toBeDefined()
    expect(window.__cmux?.pick).toBeDefined()
    expect(window.__cmux?.close).toBeDefined()
  })

  it('start() toggles cursor, inflight() is null', () => {
    const { relay } = fakeRelay()
    mount(relay)
    expect(document.documentElement.style.cursor).toBe('')
    window.__cmux!.start()
    expect(document.documentElement.style.cursor).toBe('crosshair')
    window.__cmux!.start()
    expect(document.documentElement.style.cursor).toBe('')
    expect(window.__cmux!.inflight()).toBeNull()
  })

  it('pick() shows popup, calls relay.state() once, renders agents and spawn rows', async () => {
    const { relay, calls } = fakeRelay()
    mount(relay)
    window.__cmux!.pick(document.querySelector('#target')!, 10, 10)
    const host = document.querySelector('[data-cmux-host]')
    const popup = host?.shadowRoot?.querySelector('.popup') as HTMLElement
    expect(popup?.style.display).toBe('flex')
    expect(calls.state).toBe(1)
    await new Promise((r) => setTimeout(r, 0))
    const options = host?.shadowRoot?.querySelectorAll('[role="option"]')
    expect(options!.length).toBeGreaterThan(0)
    const idle = host?.shadowRoot?.querySelector('[data-pane-id="w1:p2"]')
    expect(idle?.getAttribute('aria-selected')).toBe('true')
    expect(host?.shadowRoot?.querySelectorAll('.spawn-row').length).toBe(2)
  })

  it('untrusted click on send button does not call relay.prompt', async () => {
    const { relay, calls } = fakeRelay()
    mount(relay)
    window.__cmux!.pick(document.querySelector('#target')!, 10, 10)
    await new Promise((r) => setTimeout(r, 0))
    const host = document.querySelector('[data-cmux-host]')
    const textarea = host?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement
    textarea.value = 'test'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    host?.shadowRoot?.querySelector('.send-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect((calls.prompt as unknown[]).length).toBe(0)
  })

  it('untrusted Enter key does not call relay.prompt', async () => {
    const { relay, calls } = fakeRelay()
    mount(relay)
    window.__cmux!.pick(document.querySelector('#target')!, 10, 10)
    await new Promise((r) => setTimeout(r, 0))
    const host = document.querySelector('[data-cmux-host]')
    const textarea = host?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement
    textarea.value = 'test'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect((calls.prompt as unknown[]).length).toBe(0)
  })

  it('untrusted input event does not update typed prompt', async () => {
    const { relay, calls } = fakeRelay()
    mount(relay)
    window.__cmux!.pick(document.querySelector('#target')!, 10, 10)
    await new Promise((r) => setTimeout(r, 0))
    const host = document.querySelector('[data-cmux-host]')
    const textarea = host?.shadowRoot?.querySelector('textarea') as HTMLTextAreaElement
    textarea.value = 'evil'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    host?.shadowRoot?.querySelector('.send-btn')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect((calls.prompt as unknown[]).length).toBe(0)
  })

  it('close() hides popup and selection() is empty', async () => {
    const { relay } = fakeRelay()
    mount(relay)
    window.__cmux!.pick(document.querySelector('#target')!, 10, 10)
    await new Promise((r) => setTimeout(r, 0))
    const popup = document.querySelector('[data-cmux-host]')?.shadowRoot?.querySelector('.popup') as HTMLElement
    window.__cmux!.close()
    expect(popup?.style.display).toBe('none')
    expect(window.__cmux!.selection()).toEqual([])
  })

  it('describe() returns ElementInfo with button#target in path', () => {
    const { relay } = fakeRelay()
    mount(relay)
    const info = window.__cmux!.describe(document.querySelector('#target')!)
    expect(info.path).toContain('button#target')
    expect(info.html).toContain('data-cmux-picked')
    expect(info.url).toBeDefined()
    expect(info.viewport).toBeDefined()
    expect(info.rect).toBeDefined()
  })
})
