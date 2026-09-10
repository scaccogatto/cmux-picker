import { mkdtempSync, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { URL } from 'node:url'
import { describe, it, expect, afterEach } from 'vitest'
import { decodeFrames, encodeFrame, createHandler, MAX_FRAME_BYTES, MAX_REPLY_BYTES } from '../native.ts'
import { startFakeCmux } from './helpers/fake-cmux.ts'
import type { FakeCmux } from './helpers/fake-cmux.ts'

const CAPABILITIES = {
  methods: ['terminal.paste', 'system.tree', 'extension.sidebar.snapshot', 'surface.split', 'workspace.create'],
  version: '0.64.22',
}

/**
 * Writes a temp CMUX_PICKER_STATE_DIR with a fabricated claude-hook-sessions.json
 * bound to surfaceId, in the real store shape: just {version, sessions}, the
 * session carrying its own surfaceId (no activeSessionsBySurface index).
 */
async function tempStateDir(opts?: { surfaceId: string; sessionId: string; lifecycle: string }): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cmp-state-'))
  if (opts) {
    await mkdir(dir, { recursive: true })
    const store = {
      version: 1,
      sessions: { [opts.sessionId]: { sessionId: opts.sessionId, surfaceId: opts.surfaceId, agentLifecycle: opts.lifecycle, updatedAt: 1 } },
    }
    await writeFile(join(dir, 'claude-hook-sessions.json'), JSON.stringify(store), 'utf8')
  }
  return dir
}

/** getState/spawnAgent read the hook stores from CMUX_PICKER_STATE_DIR; run fn with it pointed at dir */
async function withStateDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env.CMUX_PICKER_STATE_DIR
  process.env.CMUX_PICKER_STATE_DIR = dir
  try {
    return await fn()
  } finally {
    if (original === undefined) delete process.env.CMUX_PICKER_STATE_DIR
    else process.env.CMUX_PICKER_STATE_DIR = original
  }
}

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

describe('createHandler', () => {
  let fake: FakeCmux | undefined
  let attachmentDir: string
  let stateDir: string

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

  const treeWithSurface = () => ({
    active: { workspace_id: 'w1', surface_id: 'surf1' },
    windows: [
      {
        id: 'win1',
        index: 0,
        selected_workspace_id: 'w1',
        workspaces: [
          {
            id: 'w1',
            index: 0,
            title: 'app',
            selected: true,
            panes: [{ surfaces: [{ id: 'surf1', index: 0, type: 'terminal', title: 'Settings polish', focused: true }] }],
          },
        ],
      },
    ],
  })

  it('state returns 200 with cmux:true and mapped agents', async () => {
    stateDir = await tempStateDir({ surfaceId: 'surf1', sessionId: 'sess1', lifecycle: 'idle' })
    fake = await startFakeCmux({
      'system.capabilities': () => CAPABILITIES,
      'system.tree': treeWithSurface,
      'extension.sidebar.snapshot': () => ({ workspaces: [{ id: 'w1', current_directory: '/tmp/proj', branch_summary: 'main' }] }),
    })
    attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir, password: null })
    const reply = await withStateDir(stateDir, () => handler({ id: '1', method: 'state', params: {} }))

    expect(reply.status).toBe(200)
    const body = reply.body as Record<string, unknown>
    expect(body.cmux).toBe(true)
    expect(body.workspaceId).toBe('w1')
    expect(body.paneId).toBe('surf1')
    expect((body.agents as Array<unknown>)[0]).toMatchObject({ agent: 'claude', agent_status: 'idle' })
  })

  it('state returns 200 with cmux:false when socket does not exist', async () => {
    attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))
    const handler = createHandler({ socketPath: '/nonexistent.sock', attachmentDir, password: null })

    const reply = await handler({ id: '2', method: 'state', params: {} })

    expect(reply.status).toBe(200)
    const body = reply.body as Record<string, unknown>
    expect(body.cmux).toBe(false)
  })

  it('state surfaces access denied legibly as cmux:false, not a crash', async () => {
    attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))
    fake = await startFakeCmux({}, { password: 'secret' })
    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir, password: 'wrong' })

    const reply = await handler({ id: '2b', method: 'state', params: {} })

    expect(reply.status).toBe(200)
    const body = reply.body as Record<string, unknown>
    expect(body).toMatchObject({ cmux: false, reason: 'access_denied' })
  })

  it('prompt validates the body, pastes into the resolved surface and returns 200', async () => {
    fake = await startFakeCmux({
      'system.tree': treeWithSurface,
      'terminal.paste': () => ({ workspace_id: 'w1', surface_id: 'surf1', submitted: true }),
    })
    attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir, password: null })
    const reply = await handler({
      id: '3',
      method: 'prompt',
      params: { target: 'surf1', prompt: 'test prompt', element },
    })

    expect(reply.status).toBe(200)
    const body = reply.body as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.submitted).toBe(true)

    const sent = fake.received.find((r) => r.method === 'terminal.paste')
    expect(sent?.params).toMatchObject({ workspace_id: 'w1', surface_id: 'surf1', submit_key: 'return' })
    const text = sent?.params.text as string
    expect(text).toContain('[cmux-picker]')
  })

  it('prompt returns 200 with submitted:false and a submit_error, not an error status', async () => {
    fake = await startFakeCmux({
      'system.tree': treeWithSurface,
      'terminal.paste': () => ({ workspace_id: 'w1', surface_id: 'surf1', submitted: false, submit_error: 'surface busy' }),
    })
    attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir, password: null })
    const reply = await handler({ id: '3b', method: 'prompt', params: { target: 'surf1', prompt: 'test', element } })

    expect(reply.status).toBe(200)
    const body = reply.body as Record<string, unknown>
    expect(body.submitted).toBe(false)
    expect(body.submit_error).toBe('surface busy')
  })

  it('prompt returns 400 for invalid body', async () => {
    fake = await startFakeCmux({})
    attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir, password: null })
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
      'system.tree': treeWithSurface,
      'terminal.paste': () => ({ workspace_id: 'w1', surface_id: 'surf1', submitted: true }),
    })
    attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const screenshotPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir, password: null })
    const reply = await handler({
      id: '5',
      method: 'prompt',
      params: { target: 'surf1', prompt: 'test', element, screenshotPng },
    })

    expect(reply.status).toBe(200)
    const body = reply.body as Record<string, unknown>
    expect(body.screenshot).toBeTruthy()
  })

  it('prompt returns 409 when the target surface is not found in the tree', async () => {
    fake = await startFakeCmux({ 'system.tree': treeWithSurface })
    attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir, password: null })
    const reply = await handler({ id: '6', method: 'prompt', params: { target: 'nope', prompt: 'test', element } })

    expect(reply.status).toBe(409)
  })

  it('spawn with mode here returns 200 and splits the focused surface', async () => {
    stateDir = await tempStateDir({ surfaceId: 'surf-new', sessionId: 'sess1', lifecycle: 'idle' })
    fake = await startFakeCmux({
      'system.tree': treeWithSurface,
      'extension.sidebar.snapshot': () => ({ workspaces: [{ id: 'w1', current_directory: '/tmp/proj' }] }),
      'surface.split': () => ({ surface_id: 'surf-new' }),
    })
    attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir, password: null })
    const reply = await withStateDir(stateDir, () => handler({ id: '7', method: 'spawn', params: { mode: 'here' } }))

    expect(reply.status).toBe(200)
    const body = reply.body as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.pane_id).toBe('surf-new')

    const split = fake.received.find((r) => r.method === 'surface.split')
    expect(split?.params).toMatchObject({ surface_id: 'surf1', workspace_id: 'w1' })
  })

  it('spawn returns 409 when nothing is focused to split next to', async () => {
    fake = await startFakeCmux({
      'system.tree': () => ({ windows: [] }),
      'extension.sidebar.snapshot': () => ({ workspaces: [] }),
    })
    attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir, password: null })
    const reply = await handler({ id: '8', method: 'spawn', params: { mode: 'here' } })

    expect(reply.status).toBe(409)
  })

  it('spawn validates the request and returns 400 for invalid body', async () => {
    fake = await startFakeCmux({})
    attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir, password: null })
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
    attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir, password: null })
    const reply = await handler({ id: '10', method: 'unknown_method', params: {} })

    expect(reply.status).toBe(404)
    const body = reply.body as Record<string, unknown>
    expect(body.error).toBe('not_found')
  })

  it('non-object message returns 400 invalid_request', async () => {
    fake = await startFakeCmux({})
    attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir, password: null })
    const reply = await handler('not an object')

    expect(reply.status).toBe(400)
    expect(reply.id).toBeNull()
    const body = reply.body as Record<string, unknown>
    expect(body.error).toBe('invalid_request')
  })

  it('message without id returns 400 with null id', async () => {
    fake = await startFakeCmux({})
    attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir, password: null })
    const reply = await handler({ method: 'state', params: {} })

    expect(reply.status).toBe(400)
    expect(reply.id).toBeNull()
  })

  it('message without method returns 400', async () => {
    fake = await startFakeCmux({})
    attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir, password: null })
    const reply = await handler({ id: '11', params: {} })

    expect(reply.status).toBe(400)
    expect(reply.id).toBe('11')
  })

  it('threads the resolved password into the socket calls: wrong password surfaces as access_denied, not a hang', async () => {
    fake = await startFakeCmux({ 'system.tree': treeWithSurface }, { password: 'secret' })
    attachmentDir = mkdtempSync(join(tmpdir(), 'cmp-att-'))

    const handler = createHandler({ socketPath: fake.socketPath, attachmentDir, password: 'wrong' })
    const reply = await handler({ id: '12', method: 'prompt', params: { target: 'surf1', prompt: 'test', element } })

    expect(reply.status).toBe(403)
    const body = reply.body as Record<string, unknown>
    expect(body.error).toBe('access_denied')
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
      'system.capabilities': () => CAPABILITIES,
      'system.tree': () => ({ windows: [] }),
      'extension.sidebar.snapshot': () => ({ workspaces: [] }),
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
