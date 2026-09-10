/**
 * Native messaging host: Chrome launches this via the manifest installed by
 * the CLI installer. Chrome pipes messages over stdin/stdout: each message is
 * a 4-byte little-endian length prefix followed by that many bytes of UTF-8
 * JSON. Stdout is the protocol channel; diagnostics go to stderr.
 */

import { resolveSocketPath } from './cmux.ts'
import { cleanupAttachments, ATTACHMENT_DIR } from './bridge.ts'
import { createHandler, decodeFrames, encodeFrame } from './native.ts'

const socketPath = resolveSocketPath(process.env.CMUX_SOCKET_PATH)

await cleanupAttachments(ATTACHMENT_DIR).catch(() => {})

const handler = createHandler({ socketPath, attachmentDir: ATTACHMENT_DIR })

let buffer: Buffer = Buffer.alloc(0)

process.stdin.on('data', (chunk: unknown) => {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
  buffer = Buffer.concat([buffer, buf]) as Buffer

  try {
    while (true) {
      const { messages, rest } = decodeFrames(buffer)
      buffer = rest

      for (const message of messages) {
        void handler(message).then((reply) => {
          process.stdout.write(encodeFrame(reply))
        })
      }

      if (messages.length === 0) break
    }
  } catch (err) {
    const message_str = err instanceof Error ? err.message : String(err)
    console.error(`[cmux-picker] ${message_str}`)
    process.exit(1)
  }
})

process.stdin.on('end', () => {
  process.exit(0)
})
