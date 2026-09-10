import { CmuxError, httpStatus, resolvePassword } from './cmux.ts'
import { getState, postPrompt, spawnAgent } from './bridge.ts'
import { validatePrompt, validateSpawn } from './validate.ts'
import type { PromptResponse, SpawnResponse, StateResponse } from './types.ts'

export const MAX_FRAME_BYTES = 16 * 1024 * 1024
export const MAX_REPLY_BYTES = 1024 * 1024

/**
 * Parses every complete frame at the front of buffer, returns the parsed JSON
 * values and the unconsumed tail; an incomplete trailing frame stays in rest;
 * a length above maxBytes throws; invalid JSON throws
 */
export function decodeFrames(buffer: Buffer, maxBytes = MAX_FRAME_BYTES): { messages: unknown[]; rest: Buffer } {
  const messages: unknown[] = []
  let pos = 0

  while (buffer.length - pos >= 4) {
    const len = buffer.readUInt32LE(pos)

    if (len > maxBytes) {
      throw new Error(`frame too large: ${len} bytes`)
    }

    if (buffer.length - pos < 4 + len) {
      break
    }

    const payload = buffer.subarray(pos + 4, pos + 4 + len)
    const json = JSON.parse(payload.toString('utf8'))
    messages.push(json)

    pos += 4 + len
  }

  return { messages, rest: buffer.subarray(pos) }
}

/** JSON → UTF-8 → length-prefixed frame */
export function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8')

  if (payload.length > MAX_REPLY_BYTES) {
    const id = (value as { id?: unknown }).id ?? null
    const reply = { id, status: 500, body: { error: 'reply_too_large', message: 'reply exceeds 1 MiB' } }
    return encodeFrame(reply)
  }

  const frame = Buffer.allocUnsafe(4 + payload.length)
  frame.writeUInt32LE(payload.length, 0)
  payload.copy(frame, 4)
  return frame
}

/** Creates a handler for Chrome Native Messaging requests */
export function createHandler(opts: {
  socketPath: string
  attachmentDir: string
  /**
   * Socket-control password. Omit the property (leave it `undefined`) to resolve it via
   * resolvePassword() (env, else cmux's password file); pass `null` explicitly to mean "no
   * password", without falling back. `??` would treat those two the same, so this checks
   * for `undefined` specifically rather than using it.
   */
  password?: string | null
}): (message: unknown) => Promise<{ id: unknown; status: number; body: unknown }> {

  // Resolved per request, not once per process: a user told "set cmux to Password
  // mode" writes the password file while this host is already running, and a value
  // cached at startup would keep refusing them until the port's idle timeout.
  const currentPassword = (): string | null => (opts.password === undefined ? resolvePassword() : opts.password)

  return async (message: unknown) => {
    const password = currentPassword()
    if (typeof message !== 'object' || message === null) {
      return { id: null, status: 400, body: { error: 'invalid_request', message: 'invalid message envelope' } }
    }

    const msg = message as Record<string, unknown>

    if (typeof msg.id !== 'string') {
      return { id: msg.id ?? null, status: 400, body: { error: 'invalid_request', message: 'invalid message envelope' } }
    }

    if (typeof msg.method !== 'string') {
      return { id: msg.id, status: 400, body: { error: 'invalid_request', message: 'invalid message envelope' } }
    }

    try {
      if (msg.method === 'state') {
        const response: StateResponse = await getState(opts.socketPath, { password })
        return { id: msg.id, status: 200, body: response }
      }

      if (msg.method === 'prompt') {
        const body = validatePrompt(msg.params)
        if (body === null) {
          return { id: msg.id, status: 400, body: { error: 'invalid_params', message: 'invalid prompt request' } }
        }

        const response: PromptResponse = await postPrompt(body, {
          socketPath: opts.socketPath,
          password,
          inlineMaxChars: 1500,
          roots: [],
          attachmentDir: opts.attachmentDir,
        })
        return { id: msg.id, status: 200, body: response }
      }

      if (msg.method === 'spawn') {
        const body = validateSpawn(msg.params)
        if (body === null) {
          return { id: msg.id, status: 400, body: { error: 'invalid_params', message: 'invalid spawn request' } }
        }

        const response: SpawnResponse = await spawnAgent(body, { socketPath: opts.socketPath, password })
        return { id: msg.id, status: 200, body: response }
      }

      return { id: msg.id, status: 404, body: { error: 'not_found', message: `unknown method ${msg.method}` } }
    } catch (err) {
      if (err instanceof CmuxError) {
        return { id: msg.id, status: httpStatus(err.code), body: { error: err.code, message: err.message } }
      }
      const message_str = err instanceof Error ? err.message : String(err)
      return { id: msg.id, status: 500, body: { error: 'internal', message: message_str } }
    }
  }
}
