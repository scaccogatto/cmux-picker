import { describe, it, expect, afterEach } from 'vitest'
import { CmuxError, httpStatus, parseLine, request } from '../cmux.ts'
import { startFakeCmux } from './helpers/fake-cmux.ts'
import type { FakeCmux } from './helpers/fake-cmux.ts'

describe('parseLine', () => {
  it('returns result on success', () => {
    const line = JSON.stringify({ id: 'abc', result: { type: 'ok', value: 1 } })
    expect(parseLine(line, 'abc')).toEqual({ type: 'ok', value: 1 })
  })

  it('throws CmuxError with code and message on error', () => {
    const line = JSON.stringify({ id: 'abc', error: { code: 'agent_blocked', message: 'nope' } })
    expect(() => parseLine(line, 'abc')).toThrow(CmuxError)
    try {
      parseLine(line, 'abc')
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(CmuxError)
      expect((err as CmuxError).code).toBe('agent_blocked')
      expect((err as CmuxError).message).toBe('nope')
    }
  })

  it('throws bad_response on id mismatch', () => {
    const line = JSON.stringify({ id: 'other', result: {} })
    try {
      parseLine(line, 'abc')
      expect.unreachable()
    } catch (err) {
      expect((err as CmuxError).code).toBe('bad_response')
    }
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
      'session.snapshot': () => ({ type: 'session_snapshot', snapshot: { version: '0.8.2' } }),
    })

    const result = await request(fake.socketPath, 'session.snapshot', {})
    expect(result).toEqual({ type: 'session_snapshot', snapshot: { version: '0.8.2' } })
    expect(fake.received).toEqual([{ method: 'session.snapshot', params: {} }])
  })

  it('rejects with CmuxError on an error line', async () => {
    fake = await startFakeCmux({
      'agent.prompt': () => ({ __error: { code: 'agent_blocked', message: 'agent is blocked' } }),
    })

    await expect(request(fake.socketPath, 'agent.prompt', { target: 'w1:p1', text: 'hi' })).rejects.toMatchObject({
      code: 'agent_blocked',
      message: 'agent is blocked',
    })
  })

  it('rejects with no_socket for ENOENT', async () => {
    await expect(request('/nonexistent/dir/cmux.sock', 'session.snapshot', {})).rejects.toMatchObject({
      code: 'no_socket',
    })
  })

  it('rejects with timeout when the handler never resolves', async () => {
    fake = await startFakeCmux({
      'agent.prompt': () => new Promise(() => {}),
    })

    await expect(request(fake.socketPath, 'agent.prompt', {}, 200)).rejects.toMatchObject({
      code: 'timeout',
    })
  })
})

describe('httpStatus', () => {
  it.each([
    ['invalid_params', 400],
    ['not_found', 404],
    ['agent_blocked', 409],
    ['busy', 503],
    ['unknown_code', 502],
    ['timeout', 502],
  ])('maps %s to %i', (code, status) => {
    expect(httpStatus(code)).toBe(status)
  })
})
