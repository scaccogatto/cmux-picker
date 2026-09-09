import { homedir } from 'node:os'
import { request, CmuxError, httpStatus } from './cmux.ts'
import { getState, postPrompt, spawnAgent } from './bridge.ts'
import { validatePrompt, validateSpawn } from './validate.ts'
import type { PromptResponse, SpawnResponse } from './types.ts'

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

/** Extracts focused workspace and pane environment from a session.snapshot result */
export function focusedEnv(snapshotResult: unknown): { env: NodeJS.ProcessEnv; cwd: string | null } {
  const env: NodeJS.ProcessEnv = {}
  let cwd: string | null = null

  if (typeof snapshotResult !== 'object' || snapshotResult === null) {
    return { env, cwd }
  }

  const obj = snapshotResult as Record<string, unknown>
  const snapshot = typeof obj.snapshot === 'object' && obj.snapshot !== null ? (obj.snapshot as Record<string, unknown>) : null

  if (snapshot === null) {
    return { env, cwd }
  }

  const focused_workspace_id = snapshot.focused_workspace_id
  const focused_pane_id = snapshot.focused_pane_id

  if (typeof focused_workspace_id === 'string') {
    env.CMUX_WORKSPACE_ID = focused_workspace_id
  }

  if (typeof focused_pane_id === 'string') {
    env.CMUX_PANE_ID = focused_pane_id

    const panes = Array.isArray(snapshot.panes) ? snapshot.panes : []
    for (const pane of panes) {
      if (typeof pane === 'object' && pane !== null) {
        const p = pane as Record<string, unknown>
        if (p.pane_id === focused_pane_id && typeof p.cwd === 'string') {
          cwd = p.cwd
          break
        }
      }
    }
  }

  return { env, cwd }
}

/** Creates a handler for Chrome Native Messaging requests */
export function createHandler(opts: {
  socketPath: string
  attachmentDir: string
}): (message: unknown) => Promise<{ id: unknown; status: number; body: unknown }> {
  return async (message: unknown) => {
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
        // ponytail: session.snapshot called twice (once here for focus, once inside getState); pass the snapshot through if this ever shows in cmux's logs
        let focusEnv = {}

        try {
          const snapshotResult = await request(opts.socketPath, 'session.snapshot', {})
          const focus = focusedEnv(snapshotResult)
          focusEnv = focus.env
        } catch (err) {
          if (!(err instanceof CmuxError)) throw err
          // fall through: use empty env and getState will produce { cmux: false, ... }
        }

        const response = await getState(opts.socketPath, focusEnv)
        return { id: msg.id, status: 200, body: response }
      }

      if (msg.method === 'prompt') {
        const body = validatePrompt(msg.params)
        if (body === null) {
          return { id: msg.id, status: 400, body: { error: 'invalid_params', message: 'invalid prompt request' } }
        }

        const response: PromptResponse = await postPrompt(body, {
          socketPath: opts.socketPath,
          inlineMaxChars: 1500,
          roots: [],
          attachmentDir: opts.attachmentDir,
        })
        return { id: msg.id, status: 200, body: response }
      }

      if (msg.method === 'spawn') {
        let snapshotResult: unknown
        let spawnEnv = {}
        let spawnCwd = ''

        try {
          snapshotResult = await request(opts.socketPath, 'session.snapshot', {})
          const focus = focusedEnv(snapshotResult)
          spawnEnv = focus.env
          spawnCwd = focus.cwd ?? ''
        } catch (err) {
          if (!(err instanceof CmuxError)) throw err
          // fall through: validate will catch the missing env
        }

        const body = validateSpawn(msg.params)
        if (body === null) {
          return { id: msg.id, status: 400, body: { error: 'invalid_params', message: 'invalid spawn request' } }
        }

        const response: SpawnResponse = await spawnAgent(body, {
          socketPath: opts.socketPath,
          root: spawnCwd || homedir(),
          env: spawnEnv,
        })
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
