import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { CmuxError, httpStatus, parseLine, request, resolvePassword } from '../cmux.ts'
import { startFakeCmux } from './helpers/fake-cmux.ts'
import type { FakeCmux } from './helpers/fake-cmux.ts'

describe('parseLine', () => {
  it('returns result on a success envelope', () => {
    const line = JSON.stringify({ id: 'abc', ok: true, result: { methods: ['terminal.paste'] } })
    expect(parseLine(line, 'abc')).toEqual({ methods: ['terminal.paste'] })
  })

  it('throws CmuxError with code and message on an error envelope', () => {
    const line = JSON.stringify({ id: 'abc', ok: false, error: { code: 'not_found', message: 'nope' } })
    expect(() => parseLine(line, 'abc')).toThrow(CmuxError)
    try {
      parseLine(line, 'abc')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(CmuxError)
      expect((err as CmuxError).code).toBe('not_found')
      expect((err as CmuxError).message).toBe('nope')
    }
  })

  it('throws access_denied on a plain ERROR: line', () => {
    const line = 'ERROR: Access denied - only processes started inside cmux can connect'
    try {
      parseLine(line, 'abc')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(CmuxError)
      expect((err as CmuxError).code).toBe('access_denied')
      expect((err as CmuxError).message).toBe(line)
    }
  })

  it('throws bad_response on id mismatch', () => {
    const line = JSON.stringify({ id: 'other', ok: true, result: {} })
    try {
      parseLine(line, 'abc')
      expect.unreachable()
    } catch (err) {
      expect((err as CmuxError).code).toBe('bad_response')
    }
  })

  it('tolerates a missing id', () => {
    const line = JSON.stringify({ ok: true, result: { value: 1 } })
    expect(parseLine(line, 'abc')).toEqual({ value: 1 })
  })

  it('throws bad_response on garbage JSON', () => {
    try {
      parseLine('not json', 'abc')
      expect.unreachable()
    } catch (err) {
      expect((err as CmuxError).code).toBe('bad_response')
    }
  })
})

describe('request', () => {
  let fake: FakeCmux | undefined

  afterEach(async () => {
    await fake?.close()
    fake = undefined
  })

  it('resolves with the result on success', async () => {
    fake = await startFakeCmux({
      'system.capabilities': () => ({ methods: ['terminal.paste', 'system.tree'] }),
    })

    const result = await request(fake.socketPath, 'system.capabilities', {})
    expect(result).toEqual({ methods: ['terminal.paste', 'system.tree'] })
    expect(fake.received).toEqual([{ method: 'system.capabilities', params: {} }])
  })

  it('rejects with CmuxError on an error envelope', async () => {
    fake = await startFakeCmux({
      'terminal.paste': () => ({ __error: { code: 'surface_unavailable', message: 'surface is gone' } }),
    })

    await expect(request(fake.socketPath, 'terminal.paste', { surface_id: 's1', text: 'hi' })).rejects.toMatchObject({
      code: 'surface_unavailable',
      message: 'surface is gone',
    })
  })

  it('rejects with no_socket for ENOENT', async () => {
    await expect(request('/nonexistent/dir/cmux.sock', 'system.tree', {})).rejects.toMatchObject({
      code: 'no_socket',
    })
  })

  it('rejects with timeout when the handler never resolves', async () => {
    fake = await startFakeCmux({
      'terminal.paste': () => new Promise(() => {}),
    })

    await expect(request(fake.socketPath, 'terminal.paste', {}, 200)).rejects.toMatchObject({
      code: 'timeout',
    })
  })

  describe('auth handshake', () => {
    it('sends the request after a correct password', async () => {
      fake = await startFakeCmux({ 'system.capabilities': () => ({ methods: [] }) }, { password: 'secret' })

      const result = await request(fake.socketPath, 'system.capabilities', {}, 3000, { password: 'secret' })
      expect(result).toEqual({ methods: [] })
    })

    it('rejects with access_denied on a wrong password', async () => {
      fake = await startFakeCmux({ 'system.capabilities': () => ({ methods: [] }) }, { password: 'secret' })

      await expect(request(fake.socketPath, 'system.capabilities', {}, 3000, { password: 'wrong' })).rejects.toMatchObject({
        code: 'access_denied',
      })
    })

    it('treats "OK: Authentication not required" as success when the server needs no password', async () => {
      fake = await startFakeCmux({ 'system.capabilities': () => ({ methods: [] }) })

      const result = await request(fake.socketPath, 'system.capabilities', {}, 3000, { password: 'stale-password' })
      expect(result).toEqual({ methods: [] })
    })

    it("treats an older server's \"Unknown command 'auth'\" as success too", async () => {
      const server = createServer((socket) => {
        socket.on('data', (chunk: Buffer) => {
          const line = chunk.toString('utf8').split('\n')[0] ?? ''
          if (line.startsWith('auth ')) {
            socket.write("ERROR: Unknown command 'auth'\n")
            return
          }
          const id = (JSON.parse(line) as { id: string }).id
          socket.write(JSON.stringify({ id, ok: true, result: { methods: [] } }) + '\n')
        })
      })
      const dir = mkdtempSync(join(tmpdir(), 'cmux-legacy-auth-'))
      const socketPath = join(dir, 's.sock')
      await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()))

      try {
        const result = await request(socketPath, 'system.capabilities', {}, 3000, { password: 'stale-password' })
        expect(result).toEqual({ methods: [] })
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    })

    it('skips the auth line entirely when no password is given', async () => {
      fake = await startFakeCmux({ 'system.capabilities': () => ({ methods: [] }) })

      const result = await request(fake.socketPath, 'system.capabilities', {})
      expect(result).toEqual({ methods: [] })
    })
  })
})

describe('resolvePassword', () => {
  it('prefers the env var over the file, trimmed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmux-picker-pw-'))
    writeFileSync(join(dir, 'socket-control-password'), 'from-file\n')

    const pw = resolvePassword({ env: { CMUX_SOCKET_PASSWORD: '  from-env  ' }, stateDir: dir })
    expect(pw).toBe('from-env')
  })

  it('falls back to the file, trimmed of trailing newlines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmux-picker-pw-'))
    writeFileSync(join(dir, 'socket-control-password'), 'file-secret\n')

    const pw = resolvePassword({ env: {}, stateDir: dir })
    expect(pw).toBe('file-secret')
  })

  it('returns null when the file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmux-picker-pw-'))

    const pw = resolvePassword({ env: {}, stateDir: dir })
    expect(pw).toBeNull()
  })

  it('returns null when the env var is empty or whitespace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmux-picker-pw-'))

    const pw = resolvePassword({ env: { CMUX_SOCKET_PASSWORD: '   ' }, stateDir: dir })
    expect(pw).toBeNull()
  })
})

describe('httpStatus', () => {
  it.each([
    ['access_denied', 403],
    ['invalid_params', 400],
    ['not_found', 404],
    ['surface_unavailable', 409],
    ['process_exited', 409],
    ['agent_not_ready', 409],
    ['busy', 503],
    ['timeout', 503],
    ['unknown_code', 502],
  ])('maps %s to %i', (code, status) => {
    expect(httpStatus(code)).toBe(status)
  })
})
