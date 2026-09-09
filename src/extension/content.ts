import type {
  Relay,
  RelayReply,
} from './picker.ts'
import type {
  PromptRequest,
  PromptResponse,
  SpawnRequest,
  SpawnResponse,
  StateResponse,
} from '../types.ts'
import { cropDataUrl } from './crop.ts'
import { mount } from './picker.ts'

// Marker to detect if the picker is already injected
const HOST_MARKER = '[data-cmux-host]'

// Margin around the picked element when capturing
const MARGIN = 40

/**
 * Send a message to the background service worker and wait for reply.
 * The background will respond with { status, body } on success
 * or { error: 'no_host' | 'capture_failed' | 'relay_failed', message } on failure.
 */
async function call(method: string, params: unknown): Promise<unknown> {
  return chrome.runtime.sendMessage({ type: 'host', method, params })
}

/**
 * Check if the picker is already injected on this page.
 * If so, exit early.
 */
if (document.querySelector(HOST_MARKER) !== null) {
  // Picker already mounted, do nothing
} else {
  /**
   * Build the relay implementation for the picker.
   * Each method communicates with the background service worker.
   */
  const relay: Relay = {
    async state(): Promise<StateResponse> {
      try {
        const reply = await call('state', {})
        if (reply && typeof reply === 'object' && 'status' in reply) {
          const r = reply as { status: number; body: unknown; error?: string }
          if (r.status === 200) {
            return r.body as StateResponse
          }
        }
        // Error reply or unexpected shape; a missing host gets an actionable message
        const error = reply as { error?: string; message?: string } | undefined
        const reason = error?.error ?? 'network_error'
        const message =
          reason === 'no_host' ? 'native host not installed, run: npx cmux-picker install-host' : (error?.message ?? 'could not reach the extension')
        return { cmux: false, reason, message }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'could not reach the extension'
        return {
          cmux: false,
          reason: 'network_error',
          message,
        }
      }
    },

    async prompt(body: PromptRequest): Promise<RelayReply<PromptResponse>> {
      const reply = await call('prompt', body)
      if (!reply || typeof reply !== 'object') {
        throw new Error('Invalid reply from background')
      }
      const r = reply as { status?: number; body?: unknown; error?: string; message?: string }
      if (r.error) {
        throw new Error(r.message ?? r.error)
      }
      return {
        status: r.status ?? 500,
        body: r.body as PromptResponse,
      }
    },

    async spawn(body: SpawnRequest): Promise<RelayReply<SpawnResponse>> {
      const reply = await call('spawn', body)
      if (!reply || typeof reply !== 'object') {
        throw new Error('Invalid reply from background')
      }
      const r = reply as { status?: number; body?: unknown; error?: string; message?: string }
      if (r.error) {
        throw new Error(r.message ?? r.error)
      }
      return {
        status: r.status ?? 500,
        body: r.body as SpawnResponse,
      }
    },

    async capture(rect: { x: number; y: number; w: number; h: number }): Promise<string> {
      const dataUrl = await chrome.runtime.sendMessage({ type: 'capture' })
      if (typeof dataUrl !== 'string') {
        throw new Error('Screenshot capture failed')
      }
      return cropDataUrl(dataUrl, rect, MARGIN, { w: innerWidth, h: innerHeight })
    },
  }

  // Mount the picker with the relay
  mount(relay)

  // Listen for the pick command from the background script
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'pick') {
      window.__cmux?.start()
    }
  })
}
