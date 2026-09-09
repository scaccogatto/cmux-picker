import { randomUUID } from 'node:crypto'
import net from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Error raised by the cmux socket client, carrying a free-form protocol
 * error code (for example agent_blocked, not_found, timeout, no_socket)
 */
export class CmuxError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CmuxError'
    this.code = code
  }
}

/**
 * Resolves the cmux Unix socket path: explicit override, then
 * CMUX_SOCKET_PATH, then the default under the user's config dir
 */
export function resolveSocketPath(override?: string): string {
  return override ?? process.env.CMUX_SOCKET_PATH ?? join(homedir(), '.config', 'cmux', 'cmux.sock')
}

function mapConnectionError(err: NodeJS.ErrnoException): CmuxError {
  if (err.code === 'ENOENT') return new CmuxError('no_socket', err.message)
  if (err.code === 'EACCES' || err.code === 'EPERM') return new CmuxError('permission', err.message)
  return new CmuxError('unreachable', err.message)
}

/**
 * Parses one NDJSON response line, checking the id and unwrapping the
 * result or throwing the cmux-reported error
 */
export function parseLine(line: string, id: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new CmuxError('bad_response', 'invalid JSON from cmux')
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new CmuxError('bad_response', 'invalid response shape from cmux')
  }

  const obj = parsed as Record<string, unknown>
  if (obj.id !== id) {
    throw new CmuxError('bad_response', 'response id mismatch')
  }

  if ('error' in obj && obj.error) {
    const err = obj.error as Record<string, unknown>
    const code = typeof err.code === 'string' ? err.code : 'unknown'
    const message = typeof err.message === 'string' ? err.message : ''
    throw new CmuxError(code, message)
  }

  return obj.result
}

/**
 * Sends one request over a fresh connection to the cmux socket: connect,
 * write one NDJSON line, read the first response line, close
 */
export function request(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 3000,
): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const id = randomUUID()
    const socket = net.createConnection(socketPath)
    let buffer = ''
    let settled = false

    const timer = setTimeout(() => {
      settle(() => reject(new CmuxError('timeout', `no response within ${timeoutMs}ms`)))
      socket.destroy()
    }, timeoutMs)

    function settle(fn: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    socket.on('connect', () => {
      socket.write(JSON.stringify({ id, method, params }) + '\n')
    })

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const idx = buffer.indexOf('\n')
      if (idx === -1) return
      const line = buffer.slice(0, idx)
      settle(() => {
        try {
          resolvePromise(parseLine(line, id))
        } catch (err) {
          reject(err)
        }
      })
      socket.end()
    })

    socket.on('error', (err: NodeJS.ErrnoException) => {
      settle(() => reject(mapConnectionError(err)))
    })

    socket.on('close', () => {
      settle(() => reject(new CmuxError('bad_response', 'connection closed before a full line was received')))
    })
  })
}

/** Maps a cmux protocol error code to an HTTP status code */
export function httpStatus(code: string): number {
  switch (code) {
    case 'invalid_params':
      return 400
    case 'not_found':
      return 404
    case 'agent_blocked':
      return 409
    case 'not_in_cmux':
      return 409
    case 'busy':
      return 503
    default:
      return 502
  }
}
