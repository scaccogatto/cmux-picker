import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Error raised by the cmux socket client, carrying a free-form protocol
 * error code (for example access_denied, not_found, timeout, no_socket)
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
 * CMUX_SOCKET_PATH, then cmux's default state-dir socket
 */
export function resolveSocketPath(override?: string): string {
  return override ?? process.env.CMUX_SOCKET_PATH ?? join(homedir(), '.local', 'state', 'cmux', 'cmux.sock')
}

/**
 * Resolves the socket-control password: CMUX_SOCKET_PASSWORD (trimmed,
 * empty treated as absent), else the contents of
 * <stateDir>/socket-control-password (trimmed of trailing newlines).
 * Returns null when neither is available; never throws.
 */
export function resolvePassword(opts?: { env?: NodeJS.ProcessEnv; stateDir?: string }): string | null {
  const env = opts?.env ?? process.env
  const fromEnv = env.CMUX_SOCKET_PASSWORD?.trim()
  if (fromEnv) return fromEnv

  const stateDir = opts?.stateDir ?? join(homedir(), '.local', 'state', 'cmux')
  try {
    const raw = readFileSync(join(stateDir, 'socket-control-password'), 'utf8')
    const trimmed = raw.replace(/[\r\n]+$/, '')
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

function mapConnectionError(err: NodeJS.ErrnoException): CmuxError {
  if (err.code === 'ENOENT') return new CmuxError('no_socket', err.message)
  if (err.code === 'EACCES' || err.code === 'EPERM') return new CmuxError('permission', err.message)
  return new CmuxError('unreachable', err.message)
}

/**
 * Parses one NDJSON response line against the cmux envelope
 * ({id,ok:true,result} / {id,ok:false,error:{code,message}}), checking the
 * id and unwrapping the result or throwing the cmux-reported error. A line
 * starting with "ERROR:" (cmux's plain-text access-control replies) maps to
 * access_denied. A missing id is tolerated: cmux does not always echo one.
 */
export function parseLine(line: string, id: string): unknown {
  if (line.startsWith('ERROR:')) {
    throw new CmuxError('access_denied', line)
  }

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
  if (obj.id !== undefined && obj.id !== id) {
    throw new CmuxError('bad_response', 'response id mismatch')
  }

  const errorField = typeof obj.error === 'object' && obj.error !== null ? (obj.error as Record<string, unknown>) : null
  if (obj.ok === false || errorField) {
    const code = typeof errorField?.code === 'string' ? errorField.code : 'unknown'
    const message = typeof errorField?.message === 'string' ? errorField.message : ''
    throw new CmuxError(code, message)
  }

  return obj.result
}

/**
 * Sends one request over a fresh connection to the cmux socket: connect,
 * optionally send "auth <password>\n" and consume its one reply line, write
 * one NDJSON request line, read the first response line, close. The auth
 * reply is treated as success when it does not start with "ERROR:" (a cmux
 * that needs no password answers "OK: Authentication not required", verified
 * against cmux 0.64.22 in automation mode), and also when it does start with
 * "ERROR:" but reports "auth" as an unknown command (older builds); any
 * other "ERROR:" auth reply rejects with access_denied without sending the
 * request.
 */
export function request(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 3000,
  opts?: { password?: string | null },
): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const id = randomUUID()
    const socket = net.createConnection(socketPath)
    // Decode as UTF-8 across chunk boundaries: a reply larger than one read can
    // split a multi-byte character, and decoding each Buffer on its own would
    // corrupt it (a path like /Users/jose/... loses its accented byte pair).
    socket.setEncoding('utf8')
    const password = opts?.password
    let buffer = ''
    let settled = false
    let authPending = typeof password === 'string' && password.length > 0

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

    function sendRequest(): void {
      socket.write(JSON.stringify({ id, method, params }) + '\n')
    }

    socket.on('connect', () => {
      if (authPending) {
        socket.write(`auth ${password}\n`)
      } else {
        sendRequest()
      }
    })

    socket.on('data', (chunk: string) => {
      buffer += chunk

      if (authPending) {
        const authIdx = buffer.indexOf('\n')
        if (authIdx === -1) return
        const authLine = buffer.slice(0, authIdx)
        buffer = buffer.slice(authIdx + 1)
        authPending = false

        const isUnknownAuthCommand = authLine.startsWith('ERROR:') && authLine.includes("Unknown command 'auth'")
        if (authLine.startsWith('ERROR:') && !isUnknownAuthCommand) {
          settle(() => reject(new CmuxError('access_denied', authLine)))
          socket.destroy()
          return
        }
        sendRequest()
      }

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
    case 'access_denied':
      return 403
    case 'invalid_params':
      return 400
    case 'not_found':
      return 404
    case 'surface_unavailable':
    case 'process_exited':
    case 'agent_not_ready':
      return 409
    case 'busy':
    case 'timeout':
      return 503
    default:
      return 502
  }
}
