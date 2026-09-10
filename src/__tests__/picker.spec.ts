// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
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
      return {
        status: 200,
        body: { ok: true, target, title: 'Settings polish', pane_id: target, screenshot: null, submitted: true, submit_error: null },
      } as RelayReply<PromptResponse>
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

/**
 * jsdom never produces a trusted event (Event.isTrusted is spec-mandated LegacyUnforgeable, so it
 * can't be faked via defineProperty, and .click()/dispatchEvent() are untrusted by spec too) - and
 * the picker deliberately only acts on trusted clicks/keys, a real guard against a page script
 * spoofing input. To exercise that gated code here without touching the guard itself, capture the
 * listener the picker registered via addEventListener and invoke it directly with a trusted-looking
 * event object; the production guards and dispatch are untouched.
 */
function capturedListener(spy: ReturnType<typeof vi.spyOn>, target: EventTarget, type: string): (e: Event) => void {
  const idx = spy.mock.calls.findIndex((args: unknown[], i: number) => args[0] === type && spy.mock.contexts[i] === target)
  if (idx === -1) throw new Error(`no "${type}" listener captured for target`)
  return spy.mock.calls[idx][1] as (e: Event) => void
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

  // The three tests below each isolate ONE trusted-event guard. Dispatching a real, jsdom-untrusted
  // event at all three entry points together (the old shape of these tests) proves nothing on its
  // own: with any single guard deleted, the other two still block the send, so calls.prompt stays
  // empty and the test keeps passing - it would not fail if the guard under test were removed. Each
  // test below first gets the prompt into a state where a send WOULD go through if the guard under
  // test were the only thing standing in the way (typed via the trusted path, via capturedListener,
  // for the click/keydown tests; a trusted Send click after the untrusted input, for the input test),
  // then exercises a real untrusted dispatch (jsdom always reports isTrusted: false for a
  // script-dispatched event) at just that one entry point.

  it('isolated: an untrusted click on Send never calls relay.prompt, even with a prompt already typed via a trusted path', async () => {
    const { relay, calls } = fakeRelay()
    const addListenerSpy = vi.spyOn(EventTarget.prototype, 'addEventListener')
    mount(relay)
    window.__cmux!.pick(document.querySelector('#target')!, 10, 10)
    await new Promise((r) => setTimeout(r, 0))

    const host = document.querySelector('[data-cmux-host]')!
    const textarea = host.shadowRoot!.querySelector('textarea') as HTMLTextAreaElement
    const sendBtn = host.shadowRoot!.querySelector('.send-btn') as HTMLElement

    textarea.value = 'do the thing'
    capturedListener(addListenerSpy, textarea, 'input')({ isTrusted: true } as unknown as Event) // trusted: typed is now set
    addListenerSpy.mockRestore()

    sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })) // real dispatch: isTrusted is false in jsdom
    await new Promise((r) => setTimeout(r, 0))

    expect((calls.prompt as unknown[]).length).toBe(0)
  })

  it('isolated: an untrusted Enter keydown never calls relay.prompt, even with a prompt already typed via a trusted path', async () => {
    const { relay, calls } = fakeRelay()
    const addListenerSpy = vi.spyOn(EventTarget.prototype, 'addEventListener')
    mount(relay)
    window.__cmux!.pick(document.querySelector('#target')!, 10, 10)
    await new Promise((r) => setTimeout(r, 0))

    const host = document.querySelector('[data-cmux-host]')!
    const textarea = host.shadowRoot!.querySelector('textarea') as HTMLTextAreaElement

    textarea.value = 'do the thing'
    capturedListener(addListenerSpy, textarea, 'input')({ isTrusted: true } as unknown as Event) // trusted: typed is now set
    addListenerSpy.mockRestore()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) // real dispatch: isTrusted is false in jsdom
    await new Promise((r) => setTimeout(r, 0))

    expect((calls.prompt as unknown[]).length).toBe(0)
  })

  it('isolated: an untrusted input event never updates the typed prompt, so a later trusted Send is refused as empty', async () => {
    const { relay, calls } = fakeRelay()
    const addListenerSpy = vi.spyOn(EventTarget.prototype, 'addEventListener')
    mount(relay)
    window.__cmux!.pick(document.querySelector('#target')!, 10, 10)
    await new Promise((r) => setTimeout(r, 0))

    const host = document.querySelector('[data-cmux-host]')!
    const textarea = host.shadowRoot!.querySelector('textarea') as HTMLTextAreaElement
    const sendBtn = host.shadowRoot!.querySelector('.send-btn') as HTMLElement
    const trustedClick = capturedListener(addListenerSpy, sendBtn, 'click')
    addListenerSpy.mockRestore()

    textarea.value = 'evil' // real dispatch below: isTrusted is false in jsdom, must not reach `typed`
    textarea.dispatchEvent(new Event('input', { bubbles: true }))

    trustedClick({ isTrusted: true } as unknown as Event) // drive send() via the trusted path directly
    await new Promise((r) => setTimeout(r, 0))

    expect((calls.prompt as unknown[]).length).toBe(0)
    // send() ran (a mode check alone would not touch the textarea) and refused an empty `typed`,
    // proving it never fell back to reading textarea.value directly.
    expect(textarea.classList.contains('invalid')).toBe(true)
  })

  it('baseline for the isolated guard tests above: a trusted input then a trusted click do call relay.prompt', async () => {
    const { relay, calls } = fakeRelay()
    const addListenerSpy = vi.spyOn(EventTarget.prototype, 'addEventListener')
    mount(relay)
    window.__cmux!.pick(document.querySelector('#target')!, 10, 10)
    await new Promise((r) => setTimeout(r, 0))

    const host = document.querySelector('[data-cmux-host]')!
    const textarea = host.shadowRoot!.querySelector('textarea') as HTMLTextAreaElement
    const sendBtn = host.shadowRoot!.querySelector('.send-btn') as HTMLElement

    textarea.value = 'do the thing'
    capturedListener(addListenerSpy, textarea, 'input')({ isTrusted: true } as unknown as Event)
    capturedListener(addListenerSpy, sendBtn, 'click')({ isTrusted: true } as unknown as Event)
    addListenerSpy.mockRestore()
    await new Promise((r) => setTimeout(r, 0))

    expect((calls.prompt as unknown[]).length).toBe(1)
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

describe('picker.mount: sending a prompt', () => {
  it('submitted:false starts no in-flight poll and toasts that the text is waiting in cmux', async () => {
    const { relay } = fakeRelay()
    relay.prompt = async (body: unknown) => {
      const { target } = body as { target: string }
      return {
        status: 200,
        body: { ok: true, target, title: 'Settings polish', pane_id: target, screenshot: null, submitted: false, submit_error: 'surface not focused' },
      } as RelayReply<PromptResponse>
    }

    const addListenerSpy = vi.spyOn(EventTarget.prototype, 'addEventListener')
    mount(relay)
    window.__cmux!.pick(document.querySelector('#target')!, 10, 10)
    await new Promise((r) => setTimeout(r, 0))

    const host = document.querySelector('[data-cmux-host]')!
    const textarea = host.shadowRoot!.querySelector('textarea') as HTMLTextAreaElement
    const sendBtn = host.shadowRoot!.querySelector('.send-btn') as HTMLElement
    textarea.value = 'do the thing'
    capturedListener(addListenerSpy, textarea, 'input')({ isTrusted: true } as unknown as Event)
    capturedListener(addListenerSpy, sendBtn, 'click')({ isTrusted: true } as unknown as Event)
    addListenerSpy.mockRestore()
    await new Promise((r) => setTimeout(r, 0))

    expect(window.__cmux!.inflight()).toBeNull()
    const toast = host.shadowRoot!.querySelector('.toast') as HTMLElement
    expect(toast.style.display).toBe('block')
    expect(toast.textContent).toContain('press Enter')
    expect(toast.textContent).toContain('surface not focused')
  })

  it('submitted:true (the default) starts the in-flight poll and does not show the "press Enter" toast', async () => {
    const { relay } = fakeRelay()

    const addListenerSpy = vi.spyOn(EventTarget.prototype, 'addEventListener')
    mount(relay)
    window.__cmux!.pick(document.querySelector('#target')!, 10, 10)
    await new Promise((r) => setTimeout(r, 0))

    const host = document.querySelector('[data-cmux-host]')!
    const textarea = host.shadowRoot!.querySelector('textarea') as HTMLTextAreaElement
    const sendBtn = host.shadowRoot!.querySelector('.send-btn') as HTMLElement
    textarea.value = 'do the thing'
    capturedListener(addListenerSpy, textarea, 'input')({ isTrusted: true } as unknown as Event)
    capturedListener(addListenerSpy, sendBtn, 'click')({ isTrusted: true } as unknown as Event)
    addListenerSpy.mockRestore()
    await new Promise((r) => setTimeout(r, 0))

    expect(window.__cmux!.inflight()).toBe('w1:p2')
    const toast = host.shadowRoot!.querySelector('.toast') as HTMLElement
    expect(toast.textContent).not.toContain('press Enter')
  })
})

describe('picker.mount: in-flight overlay', () => {
  it('clears the overlay once the poll passes its deadline without the target ever settling', async () => {
    vi.useFakeTimers()
    try {
      const { relay } = fakeRelay()
      // A target that never reports 'working' and never settles either (idle/done/blocked): a
      // plain shell, or an agent still stuck at its trust prompt - exactly what the fix guards
      // against, so nothing else in startInflightPoll would ever clear the overlay on its own.
      // `session` stays non-null so pickAgent still preselects this row.
      relay.state = async () => ({
        cmux: true,
        workspaceId: 'w1',
        paneId: 'w1:p1',
        workspaces: [{ workspace_id: 'w1', label: 'app', number: 1, focused: true }],
        agents: [
          { pane_id: 'w1:p2', workspace_id: 'w1', agent_status: 'unknown', agent: 'claude', title: 'Never settles', branch: 'main', session: 's1', focused: false, cwd: null },
        ],
        screenshot: 'available',
      }) as StateResponse

      const addListenerSpy = vi.spyOn(EventTarget.prototype, 'addEventListener')
      mount(relay)
      window.__cmux!.pick(document.querySelector('#target')!, 10, 10)
      await vi.advanceTimersByTimeAsync(10)

      const host = document.querySelector('[data-cmux-host]')!
      const textarea = host.shadowRoot!.querySelector('textarea') as HTMLTextAreaElement
      const sendBtn = host.shadowRoot!.querySelector('.send-btn') as HTMLElement
      textarea.value = 'do the thing'
      capturedListener(addListenerSpy, textarea, 'input')({ isTrusted: true } as unknown as Event)
      capturedListener(addListenerSpy, sendBtn, 'click')({ isTrusted: true } as unknown as Event)
      addListenerSpy.mockRestore()
      await vi.advanceTimersByTimeAsync(10)

      expect(window.__cmux!.inflight()).toBe('w1:p2')

      // INFLIGHT_MAX_MS is 30 minutes (src/extension/picker.ts, not exported). Advance to just
      // short of it: the poll (every 2s) has had plenty of chances to clear early and did not.
      await vi.advanceTimersByTimeAsync(29 * 60 * 1000)
      expect(window.__cmux!.inflight()).toBe('w1:p2')

      // Past the deadline: the next poll tick must give up and clear the overlay.
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
      expect(window.__cmux!.inflight()).toBeNull()

      const inflightBox = host.shadowRoot!.querySelector('.inflight') as HTMLElement
      const inflightChip = host.shadowRoot!.querySelector('.inflight-chip') as HTMLElement
      expect(inflightBox.style.display).toBe('none')
      expect(inflightChip.style.display).toBe('none')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('picker.mount: not-reachable notice', () => {
  it.each([
    ['access_denied', ['Automation mode', 'Password mode']],
    ['no_socket', ['cmux is not running']],
    ['capabilities', ['too old']],
    ['some_future_reason', ['some_future_reason']],
  ])('explains reason "%s"', async (reason, expectedSubstrings) => {
    const { relay } = fakeRelay()
    relay.state = async () => ({ cmux: false, reason, message: 'x' }) as StateResponse

    mount(relay)
    window.__cmux!.pick(document.querySelector('#target')!, 10, 10)
    await new Promise((r) => setTimeout(r, 0))

    const host = document.querySelector('[data-cmux-host]')!
    const notice = host.shadowRoot!.querySelector('.agents-notice') as HTMLElement
    expect(notice.hidden).toBe(false)
    for (const substring of expectedSubstrings) expect(notice.textContent).toContain(substring)
  })
})
