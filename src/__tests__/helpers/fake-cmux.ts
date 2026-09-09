import { mkdtempSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A cmux socket line request as received by the fake server */
export interface FakeCmux {
  socketPath: string
  received: { method: string; params: Record<string, unknown> }[]
  pushEvent(line: unknown): void
  subscriptionOpen(): boolean
  close(): Promise<void>
}

interface Message {
  id: string
  method: string
  params: Record<string, unknown>
}

/**
 * Starts a fake cmux Unix socket server for tests. Each handler receives
 * the request params and returns a result object, or `{ __error: { code, message } }`
 * to have the fake answer with an error line. `events.subscribe` is handled
 * specially: it answers with `subscription_started` and keeps the connection
 * open so `pushEvent` can push further event lines.
 */
export function startFakeCmux(handlers: Record<string, (params: Record<string, unknown>) => unknown>): Promise<FakeCmux> {
  const dir = mkdtempSync(join(tmpdir(), 'vph-'))
  const socketPath = join(dir, 's.sock')
  const received: { method: string; params: Record<string, unknown> }[] = []
  const sockets = new Set<net.Socket>()
  let subscribeSocket: net.Socket | null = null

  async function handleLine(socket: net.Socket, line: string): Promise<void> {
    const msg = JSON.parse(line) as Message
    received.push({ method: msg.method, params: msg.params })

    if (msg.method === 'events.subscribe') {
      subscribeSocket = socket
      socket.write(JSON.stringify({ id: msg.id, result: { type: 'subscription_started' } }) + '\n')
      return
    }

    const handler = handlers[msg.method]
    if (!handler) {
      socket.write(JSON.stringify({ id: msg.id, error: { code: 'not_found', message: `unknown method ${msg.method}` } }) + '\n')
      return
    }

    const result = await handler(msg.params)
    if (result && typeof result === 'object' && '__error' in result) {
      const err = (result as { __error: { code: string; message: string } }).__error
      socket.write(JSON.stringify({ id: msg.id, error: err }) + '\n')
      return
    }

    socket.write(JSON.stringify({ id: msg.id, result }) + '\n')
  }

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
      if (subscribeSocket === socket) subscribeSocket = null
    })
    // A subscription socket destroyed client-side (watchAgent closing) can leave
    // a pending write racing the close; without a listener that surfaces as an
    // unhandled 'error' event and crashes the test process.
    socket.on('error', () => {})

    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let idx = buffer.indexOf('\n')
      while (idx !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line) void handleLine(socket, line)
        idx = buffer.indexOf('\n')
      }
    })
  })

  return new Promise((resolvePromise, reject) => {
    server.on('error', reject)
    server.listen(socketPath, () => {
      resolvePromise({
        socketPath,
        received,
        pushEvent(line: unknown) {
          subscribeSocket?.write(JSON.stringify(line) + '\n')
        },
        subscriptionOpen() {
          return subscribeSocket !== null
        },
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
