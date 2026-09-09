import { HOST_NAME } from '../host-name.ts'

const PORT_IDLE_MS = 60_000

/** Lazy-initialized native messaging port */
let port: chrome.runtime.Port | null = null

/** Pending requests awaiting replies from the host */
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

/** Idle timer that disconnects the port when no requests are pending */
let idleTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Classify an error message to determine if it's a "no_host" or "relay_failed" error.
 */
function classify(message: string): 'no_host' | 'relay_failed' {
  if (/not found|forbidden/i.test(message)) {
    return 'no_host'
  }
  return 'relay_failed'
}

/**
 * Clear any pending idle timer.
 */
function clearIdleTimer(): void {
  if (idleTimer !== undefined) {
    clearTimeout(idleTimer)
    idleTimer = undefined
  }
}

/**
 * Arm an idle timer that disconnects the port when no requests are pending.
 */
function armIdleTimer(): void {
  clearIdleTimer()
  // Only arm if no pending requests
  if (pending.size === 0) {
    idleTimer = globalThis.setTimeout(() => {
      if (port !== null && pending.size === 0) {
        port.disconnect()
        port = null
      }
    }, PORT_IDLE_MS)
  }
}

/**
 * Ensure the native messaging port is connected.
 */
function ensurePort(): void {
  if (port === null) {
    port = chrome.runtime.connectNative(HOST_NAME)

    // Handle messages from the native host
    port.onMessage.addListener((message: unknown) => {
      const msg = message as { id?: string; status?: number; body?: unknown }
      const id = msg.id
      if (typeof id !== 'string') return

      const entry = pending.get(id)
      if (!entry) return

      pending.delete(id)
      entry.resolve({ status: msg.status, body: msg.body })
      armIdleTimer()
    })

    // Handle port disconnect
    port.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message ?? 'native host disconnected'
      const error = new Error(message)

      // Reject all pending requests
      for (const entry of pending.values()) {
        entry.reject(error)
      }
      pending.clear()

      // Clear the port
      port = null
      clearIdleTimer()
    })
  }
}

/**
 * Call a method on the native host and wait for a reply.
 */
async function callHost(
  method: string,
  params: unknown
): Promise<{ status: number; body: unknown }> {
  ensurePort()

  if (port === null) {
    throw new Error('Failed to connect to native host')
  }

  const id = crypto.randomUUID()
  clearIdleTimer()

  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    pending.set(id, {
      resolve: (v: unknown) => {
        resolve(v as { status: number; body: unknown })
      },
      reject,
    })

    try {
      port!.postMessage({ id, method, params })
    } catch (err) {
      pending.delete(id)
      const message = err instanceof Error ? err.message : 'Unknown error'
      reject(new Error(message))
    }
  })
}

/**
 * Inject the content script into a tab and trigger the picker.
 */
async function pickInTab(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    })
    await chrome.tabs.sendMessage(tabId, { type: 'pick' })
  } catch (err) {
    console.warn('Failed to pick in tab', tabId, err)
  }
}

/**
 * Handle keyboard command (Ctrl+B / MacCtrl+B).
 */
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'pick' && tab?.id !== undefined) {
    void pickInTab(tab.id)
  }
})

/**
 * Handle toolbar icon click.
 */
chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) {
    void pickInTab(tab.id)
  }
})

/**
 * Handle messages from content scripts.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only accept messages from this extension's content scripts
  if (sender.id !== chrome.runtime.id) {
    return false
  }

  const msg = message as { type?: string; method?: string; params?: unknown }

  // Handle screenshot capture
  if (msg.type === 'capture') {
    void (async () => {
      try {
        const windowId = sender.tab?.windowId ?? undefined
        const dataUrl = windowId !== undefined
          ? await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
          : await chrome.tabs.captureVisibleTab({ format: 'png' })
        sendResponse(dataUrl)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        sendResponse({ error: 'capture_failed', message })
      }
    })()
    return true
  }

  // Handle native host relay
  if (msg.type === 'host') {
    void (async () => {
      try {
        const reply = await callHost(msg.method ?? '', msg.params)
        sendResponse(reply)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        sendResponse({ error: classify(message), message })
      }
    })()
    return true
  }

  // Unrecognized message
  return false
})

/**
 * Expose pickInTab for e2e testing.
 */
Object.assign(globalThis, { __cmuxPick: pickInTab })
