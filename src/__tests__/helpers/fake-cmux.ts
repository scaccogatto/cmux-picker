import { mkdtempSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A fake cmux socket server for tests */
export interface FakeCmux {
  socketPath: string
  received: { method: string; params: Record<string, unknown> }[]
  close(): Promise<void>
}

interface Message {
  id: string
  method: string
  params: Record<string, unknown>
}

interface FakeCmuxOptions {
  /** When set, each connection's first line must be "auth <password>" */
  password?: string
}

/**
 * Decides what to do with a connection's first line when it might be an
 * auth preamble. Returns true when the line was consumed as auth handling
 * (so the caller must not also treat it as a request line), false when it
 * should fall through to normal method dispatch.
 */
function handleAuthLine(socket: net.Socket, line: string, password: string | undefined, markDead: () => void): boolean {
  if (line.startsWith('auth ')) {
    const sent = line.slice('auth '.length)
    if (password === undefined) {
      // No password configured server-side: mirror a cmux instance in a mode
      // that needs no auth, which still answers "unknown command" but keeps
      // the connection alive.
      // cmux 0.64.22 in automation mode answers this to a stray auth line
      socket.write('OK: Authentication not required\n')
      return true
    }
    if (sent === password) {
      socket.write('OK\n')
    } else {
      socket.write('ERROR: Access denied\n')
      markDead()
    }
    return true
  }
  if (password !== undefined) {
    // Password required but the connection opened with a request line instead.
    socket.write('ERROR: Access denied\n')
    markDead()
    return true
  }
  return false
}

/**
 * Starts a fake cmux Unix socket server for tests. Each handler receives
 * the request params and returns a result object, or
 * `{ __error: { code, message } }` to have the fake answer with the cmux
 * error envelope. An unknown method answers `ok:false` with code
 * `method_not_found`.
 *
 * `options.password`, when set, requires each connection to open with
 * "auth <password>": a match answers "OK", anything else answers
 * "ERROR: Access denied" and the connection stops responding. With no
 * password configured, an "auth ..." line sent anyway answers
 * "OK: Authentication not required" (what a real cmux answers) and the
 * connection continues normally,
 * matching cmux in automation/allowAll mode.
 */
export function startFakeCmux(
  handlers: Record<string, (params: Record<string, unknown>) => unknown>,
  options: FakeCmuxOptions = {},
): Promise<FakeCmux> {
  const dir = mkdtempSync(join(tmpdir(), 'cmux-picker-'))
  const socketPath = join(dir, 's.sock')
  const received: { method: string; params: Record<string, unknown> }[] = []
  const sockets = new Set<net.Socket>()

  async function handleLine(socket: net.Socket, line: string): Promise<void> {
    const msg = JSON.parse(line) as Message
    received.push({ method: msg.method, params: msg.params })

    const handler = handlers[msg.method]
    if (!handler) {
      socket.write(JSON.stringify({ id: msg.id, ok: false, error: { code: 'method_not_found', message: `unknown method ${msg.method}` } }) + '\n')
      return
    }

    const result = await handler(msg.params)
    if (result && typeof result === 'object' && '__error' in result) {
      const err = (result as { __error: { code: string; message: string } }).__error
      socket.write(JSON.stringify({ id: msg.id, ok: false, error: err }) + '\n')
      return
    }

    socket.write(JSON.stringify({ id: msg.id, ok: true, result }) + '\n')
  }

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})

    let buffer = ''
    let authState: 'pending' | 'done' | 'dead' = 'pending'

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let idx = buffer.indexOf('\n')
      while (idx !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        idx = buffer.indexOf('\n')

        if (authState === 'dead') continue

        if (authState === 'pending') {
          authState = 'done'
          const consumed = handleAuthLine(socket, line, options.password, () => {
            authState = 'dead'
          })
          if (consumed) continue
        }

        if (line) void handleLine(socket, line)
      }
    })
  })

  return new Promise((resolvePromise, reject) => {
    server.on('error', reject)
    server.listen(socketPath, () => {
      resolvePromise({
        socketPath,
        received,
        close() {
          return new Promise<void>((res) => {
            for (const socket of sockets) socket.destroy()
            server.close(() => res())
          })
        },
      })
    })
  })
}
