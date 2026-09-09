import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { URL } from 'node:url'
import { describe, it, expect, afterEach } from 'vitest'
import { decodeFrames, encodeFrame, focusedEnv, createHandler, MAX_FRAME_BYTES, MAX_REPLY_BYTES } from '../native.ts'
import { startFakeCmux } from './helpers/fake-cmux.ts'
import type { FakeCmux } from './helpers/fake-cmux.ts'

describe('decodeFrames', () => {
  it('parses a single frame', () => {
    const value = { id: '123', method: 'state', params: {} }
    const payload = Buffer.from(JSON.stringify(value), 'utf8')
    const frame = Buffer.allocUnsafe(4 + payload.length)
    frame.writeUInt32LE(payload.length, 0)
    payload.copy(frame, 4)

    const result = decodeFrames(frame)
    expect(result.messages).toEqual([value])
    expect(result.rest.length).toBe(0)
  })

  it('parses two frames in one buffer', () => {
    const value1 = { id: '1' }
    const value2 = { id: '2' }
    const payload1 = Buffer.from(JSON.stringify(value1), 'utf8')
    const payload2 = Buffer.from(JSON.stringify(value2), 'utf8')

    const frame1 = Buffer.allocUnsafe(4 + payload1.length)
    frame1.writeUInt32LE(payload1.length, 0)
    payload1.copy(frame1, 4)

    const frame2 = Buffer.allocUnsafe(4 + payload2.length)
    frame2.writeUInt32LE(payload2.length, 0)
    payload2.copy(frame2, 4)

    const combined = Buffer.concat([frame1, frame2])
    const result = decodeFrames(combined)
    expect(result.messages).toEqual([value1, value2])
    expect(result.rest.length).toBe(0)
  })

  it('handles a frame split across two chunks', () => {
    const value = { id: 'xyz' }
    const payload = Buffer.from(JSON.stringify(value), 'utf8')
    const frame = Buffer.allocUnsafe(4 + payload.length)
    frame.writeUInt32LE(payload.length, 0)
    payload.copy(frame, 4)

    // Split after the length header
    const firstChunk = frame.subarray(0, 2)
    const result1 = decodeFrames(firstChunk)
    expect(result1.messages).toHaveLength(0)
    expect(result1.rest.length).toBe(2)

    // Feed the rest
    const combined = Buffer.concat([result1.rest, frame.subarray(2)])
    const result2 = decodeFrames(combined)
    expect(result2.messages).toEqual([value])
    expect(result2.rest.length).toBe(0)
  })

  it('throws on oversize length', () => {
    const frame = Buffer.allocUnsafe(4)
    frame.writeUInt32LE(MAX_FRAME_BYTES + 1, 0)

    expect(() => decodeFrames(frame)).toThrow('frame too large: ' + (MAX_FRAME_BYTES + 1) + ' bytes')
  })

  it('keeps an incomplete frame in rest', () => {
    const value = { id: 'test' }
    const payload = Buffer.from(JSON.stringify(value), 'utf8')
    const frame = Buffer.allocUnsafe(4 + payload.length)
    frame.writeUInt32LE(payload.length, 0)
    payload.copy(frame, 4)

    // Only provide 3 bytes of length + part of payload
    const partial = frame.subarray(0, 7)
    const result = decodeFrames(partial)
    expect(result.messages).toHaveLength(0)
    expect(result.rest).toEqual(partial)
  })
})

describe('encodeFrame', () => {
  it('encodes a value to length-prefixed UTF-8', () => {
    const value = { id: '1', status: 200, body: { ok: true } }
    const frame = encodeFrame(value)

    const len = frame.readUInt32LE(0)
    const payload = frame.subarray(4)
    expect(payload.length).toBe(len)
    expect(JSON.parse(payload.toString('utf8'))).toEqual(value)
  })

  it('round-trips with decodeFrames', () => {
    const value = { id: 'test', data: { nested: [1, 2, 3] } }
    const frame = encodeFrame(value)
    const result = decodeFrames(frame)
    expect(result.messages).toEqual([value])
  })

  it('returns a reply_too_large error when payload exceeds MAX_REPLY_BYTES', () => {
    const hugeArray = new Array(MAX_REPLY_BYTES).fill('x')
    const value = { id: 'big', data: hugeArray }
    const frame = encodeFrame(value)

    const result = decodeFrames(frame)
    expect(result.messages).toHaveLength(1)
    const reply = result.messages[0] as Record<string, unknown>
    expect(reply.id).toBe('big')
    expect(reply.status).toBe(500)
    const body = reply.body as Record<string, unknown>
    expect(body.error).toBe('reply_too_large')
  })
})

describe('focusedEnv', () => {
  it('extracts workspace and pane ids from a snapshot', () => {
    const snapshot = {
      snapshot: {
        focused_workspace_id: 'w1',
        focused_pane_id: 'w1:p1',
        panes: [
          { pane_id: 'w1:p1', cwd: '/tmp/proj' },
          { pane_id: 'w1:p2', cwd: '/other' },
        ],
      },
    }

    const result = focusedEnv(snapshot)
    expect(result.env).toStrictEqual({ CMUX_WORKSPACE_ID: 'w1', CMUX_PANE_ID: 'w1:p1' })
    expect(result.cwd).toBe('/tmp/proj')
  })

  it('returns empty env and null cwd when snapshot has no focus', () => {
    const snapshot = {
      snapshot: {
        panes: [],
      },
    }

    const result = focusedEnv(snapshot)
    expect(result.env).toStrictEqual({})
    expect(result.cwd).toBeNull()
  })

  it('only includes keys when they have string values', () => {
    const snapshot = {
      snapshot: {
        focused_workspace_id: 'w1',
        focused_pane_id: null, // not a string
        panes: [],
      },
    }

    const result = focusedEnv(snapshot)
    expect(result.env).toStrictEqual({ CMUX_WORKSPACE_ID: 'w1' })
    expect('CMUX_PANE_ID' in result.env).toBe(false)
  })

  it('returns empty env and null cwd for non-object input', () => {
    const result = focusedEnv('not an object')
    expect(result.env).toStrictEqual({})
    expect(result.cwd).toBeNull()
  })

  it('finds cwd matching the focused pane id', () => {
    const snapshot = {
      snapshot: {
        focused_pane_id: 'w2:p5',
        panes: [
          { pane_id: 'w1:p1', cwd: '/first' },
          { pane_id: 'w2:p5', cwd: '/found' },
          { pane_id: 'w2:p6', cwd: '/other' },
        ],
      },
    }

    const result = focusedEnv(snapshot)
    expect(result.cwd).toBe('/found')
  })
})

describe('createHandler', () => {
  let fake: FakeCmux | undefined
  let attachmentDir: string

  afterEach(async () => {
    await fake?.close()
    fake = undefined
  })

  const element = {
    url: 'http://localhost:3000/page',
    viewport: { w: 1440, h: 900 },
    hint: 'src/components/Button.tsx:42:10',
    path: 'body > main > button.primary',
    rect: { x: 100, y: 200, w: 320, h: 40 },
    html: '<button class="primary">Click me</button>',
    styles: { display: 'inline-flex' },
  }

  it('state returns 200 with cmux:true and mapped agents', async () => {
    fake = await startFakeCmux({
      'session.snapshot': () => ({
        type: 'session_snapshot',
        snapshot: {
          version: '0.8.2',
          protocol: 20,
          focused_workspace_id: 'w1',
          focused_pane_id: 'w1:p1',
          workspaces: [{ workspace_id: 'w1', label: 'app', number: 1, focused: true }],
          panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', focused: true, cwd: '/tmp/proj' }],
          agents: [
            {
              pane_id: 'w1:p2',
              workspace_id: 'w1',
              agent_status: 'idle',
              focused: false,
              agent: 'claude',
              cwd: '/tmp/proj',
              terminal_title_stripped: 'Settings polish',
              tokens: { branch: 'main' },
              agent_session: { value: 's1' },
            },
          ],
        },
      }),
    })
    attachmentDir = mkdtempSync(join(tmpdir(), 'vph-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir })
    const reply = await handler({ id: '1', method: 'state', params: {} })

    expect(reply.status).toBe(200)
    const body = reply.body as Record<string, unknown>
    expect(body.cmux).toBe(true)
    expect(body.workspaceId).toBe('w1')
    expect(body.paneId).toBe('w1:p1')
    expect((body.agents as Array<unknown>)[0]).toMatchObject({ agent: 'claude' })
  })

  it('state returns 200 with cmux:false when socket does not exist', async () => {
    attachmentDir = mkdtempSync(join(tmpdir(), 'vph-att-'))
    const handler = createHandler({ socketPath: '/nonexistent.sock', attachmentDir })

    const reply = await handler({ id: '2', method: 'state', params: {} })

    expect(reply.status).toBe(200)
    const body = reply.body as Record<string, unknown>
    expect(body.cmux).toBe(false)
  })

  it('prompt validates the body and returns 200 on success', async () => {
    fake = await startFakeCmux({
      'session.snapshot': () => ({
        snapshot: {
          version: '0.8.2',
          protocol: 20,
          panes: [],
          agents: [],
        },
      }),
      'agent.prompt': () => ({ type: 'agent_prompted', agent: { terminal_title_stripped: 'agent' } }),
    })
    attachmentDir = mkdtempSync(join(tmpdir(), 'vph-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir })
    const reply = await handler({
      id: '3',
      method: 'prompt',
      params: { target: 'w1:p1', prompt: 'test prompt', element },
    })

    expect(reply.status).toBe(200)
    const body = reply.body as Record<string, unknown>
    expect(body.ok).toBe(true)

    const sent = fake.received.find((r) => r.method === 'agent.prompt')
    const text = sent?.params.text as string
    expect(text).toContain('[cmux-picker]')
  })

  it('prompt returns 400 for invalid body', async () => {
    fake = await startFakeCmux({})
    attachmentDir = mkdtempSync(join(tmpdir(), 'vph-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir })
    const reply = await handler({
      id: '4',
      method: 'prompt',
      params: { target: '', prompt: 'test', element }, // empty target is invalid
    })

    expect(reply.status).toBe(400)
    const body = reply.body as Record<string, unknown>
    expect(body.error).toBe('invalid_params')
  })

  it('prompt with screenshotPng writes the file', async () => {
    fake = await startFakeCmux({
      'session.snapshot': () => ({
        snapshot: { version: '0.8.2', protocol: 20, panes: [], agents: [] },
      }),
      'agent.prompt': () => ({ type: 'agent_prompted', agent: { terminal_title_stripped: 'agent' } }),
    })
    attachmentDir = mkdtempSync(join(tmpdir(), 'vph-att-'))

    const screenshotPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir })
    const reply = await handler({
      id: '5',
      method: 'prompt',
      params: { target: 'w1:p1', prompt: 'test', element, screenshotPng },
    })

    expect(reply.status).toBe(200)
    const body = reply.body as Record<string, unknown>
    expect(body.screenshot).toBeTruthy()
  })

  it('prompt returns 409 when agent.prompt errors with agent_blocked', async () => {
    fake = await startFakeCmux({
      'session.snapshot': () => ({
        snapshot: { version: '0.8.2', protocol: 20, panes: [], agents: [] },
      }),
      'agent.prompt': () => ({ __error: { code: 'agent_blocked', message: 'busy' } }),
    })
    attachmentDir = mkdtempSync(join(tmpdir(), 'vph-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir })
    const reply = await handler({
      id: '6',
      method: 'prompt',
      params: { target: 'w1:p1', prompt: 'test', element },
    })

    expect(reply.status).toBe(409)
  })

  it('spawn with mode here returns 200 and splits the pane', async () => {
    fake = await startFakeCmux({
      'session.snapshot': () => ({
        snapshot: {
          version: '0.8.2',
          protocol: 20,
          focused_pane_id: 'w1:p1',
          panes: [{ pane_id: 'w1:p1', cwd: '/tmp/proj' }],
        },
      }),
      'pane.split': () => ({ pane: { pane_id: 'w1:p9' } }),
      'agent.start': () => ({ agent: { pane_id: 'w1:p9' } }),
    })
    attachmentDir = mkdtempSync(join(tmpdir(), 'vph-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir })
    const reply = await handler({
      id: '7',
      method: 'spawn',
      params: { mode: 'here' },
    })

    expect(reply.status).toBe(200)
    const body = reply.body as Record<string, unknown>
    expect(body.ok).toBe(true)

    const split = fake.received.find((r) => r.method === 'pane.split')
    expect(split?.params.target_pane_id).toBe('w1:p1')
  })

  it('spawn returns 409 when focused_pane_id is missing', async () => {
    fake = await startFakeCmux({
      'session.snapshot': () => ({
        snapshot: { version: '0.8.2', protocol: 20, panes: [] },
      }),
    })
    attachmentDir = mkdtempSync(join(tmpdir(), 'vph-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir })
    const reply = await handler({
      id: '8',
      method: 'spawn',
      params: { mode: 'here' },
    })

    expect(reply.status).toBe(409)
  })

  it('spawn validates the request and returns 400 for invalid body', async () => {
    fake = await startFakeCmux({})
    attachmentDir = mkdtempSync(join(tmpdir(), 'vph-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir })
    const reply = await handler({
      id: '9',
      method: 'spawn',
      params: { mode: 'invalid' }, // not 'here' or 'worktree'
    })

    expect(reply.status).toBe(400)
    const body = reply.body as Record<string, unknown>
    expect(body.error).toBe('invalid_params')
  })

  it('unknown method returns 404', async () => {
    fake = await startFakeCmux({})
    attachmentDir = mkdtempSync(join(tmpdir(), 'vph-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir })
    const reply = await handler({ id: '10', method: 'unknown_method', params: {} })

    expect(reply.status).toBe(404)
    const body = reply.body as Record<string, unknown>
    expect(body.error).toBe('not_found')
  })

  it('non-object message returns 400 invalid_request', async () => {
    fake = await startFakeCmux({})
    attachmentDir = mkdtempSync(join(tmpdir(), 'vph-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir })
    const reply = await handler('not an object')

    expect(reply.status).toBe(400)
    expect(reply.id).toBeNull()
    const body = reply.body as Record<string, unknown>
    expect(body.error).toBe('invalid_request')
  })

  it('message without id returns 400 with null id', async () => {
    fake = await startFakeCmux({})
    attachmentDir = mkdtempSync(join(tmpdir(), 'vph-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir })
    const reply = await handler({ method: 'state', params: {} })

    expect(reply.status).toBe(400)
    expect(reply.id).toBeNull()
  })

  it('message without method returns 400', async () => {
    fake = await startFakeCmux({})
    attachmentDir = mkdtempSync(join(tmpdir(), 'vph-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir })
    const reply = await handler({ id: '11', params: {} })

    expect(reply.status).toBe(400)
    expect(reply.id).toBe('11')
  })
})

describe('host smoke test', () => {
  let fake: FakeCmux | undefined

  afterEach(async () => {
    await fake?.close()
    fake = undefined
  })

  const hostPath = fileURLToPath(new URL('./dist/host.js', import.meta.url))
  const shouldRun = existsSync(hostPath)

  it.skipIf(!shouldRun)('spawned host process can handle framed messages', async () => {
    const { spawn } = await import('node:child_process')

    fake = await startFakeCmux({
      'session.snapshot': () => ({
        snapshot: { version: '0.8.2', protocol: 20, panes: [], agents: [] },
      }),
    })

    const proc = spawn(process.execPath, [hostPath], {
      env: { ...process.env, CMUX_SOCKET_PATH: fake.socketPath },
    })

    const messageFrame = encodeFrame({ id: '1', method: 'state', params: {} })

    // Collect stdout
    const chunks: Buffer[] = []
    await new Promise<void>((resolvePromise, reject) => {
      proc.stdout?.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })

      proc.stdout?.on('end', () => {
        resolvePromise()
      })

      proc.on('error', reject)
      proc.on('exit', (code) => {
        if (code !== 0) reject(new Error(`process exited with code ${code}`))
      })

      // Send the request
      proc.stdin?.write(messageFrame)

      // Wait a moment for processing, then close stdin
      setTimeout(() => {
        proc.stdin?.end()
      }, 100)

      // Set a timeout to fail if no response
      setTimeout(() => {
        proc.kill()
        reject(new Error('timeout waiting for response'))
      }, 5000)
    })

    // Decode the response
    const responseBuffer = Buffer.concat(chunks)
    const { messages } = decodeFrames(responseBuffer)

    expect(messages).toHaveLength(1)
    const reply = messages[0] as Record<string, unknown>
    expect(reply.id).toBe('1')
    expect(reply.status).toBe(200)
    const body = reply.body as Record<string, unknown>
    expect(body.cmux).toBe(true)
  })
})
