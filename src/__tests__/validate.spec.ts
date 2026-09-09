import { describe, it, expect } from 'vitest'
import { validatePrompt, validateSpawn } from '../validate.ts'
import type { ElementInfo, PromptRequest } from '../types.ts'

function fixtureElement(overrides?: Partial<ElementInfo>): ElementInfo {
  return {
    url: 'http://localhost:3000/page',
    viewport: { w: 1440, h: 900 },
    hint: 'src/components/Button.tsx:42:10',
    path: 'body > main > button.primary',
    rect: { x: 100, y: 200, w: 320, h: 40 },
    html: '<button class="primary">Click me</button>',
    styles: { display: 'inline-flex' },
    ...overrides,
  }
}

function fixtureBody(overrides?: Partial<PromptRequest>): PromptRequest {
  return {
    target: 'w1:p1',
    prompt: 'make it red',
    element: fixtureElement(),
    ...overrides,
  }
}

describe('validatePrompt', () => {
  it('accepts a valid fixture', () => {
    const body = fixtureBody()
    expect(validatePrompt(body)).toEqual(body)
  })

  it('ignores unknown extra top-level keys', () => {
    const body = { ...fixtureBody(), extra: 'ignored' }
    expect(validatePrompt(body)).not.toBeNull()
  })

  it('rejects missing target', () => {
    const body = { prompt: 'x', element: fixtureElement() }
    expect(validatePrompt(body)).toBeNull()
  })

  it('rejects a prompt over 20000 chars', () => {
    const body = fixtureBody({ prompt: 'x'.repeat(20001) })
    expect(validatePrompt(body)).toBeNull()
  })

  it('rejects a numeric hint', () => {
    const body = fixtureBody({ element: fixtureElement({ hint: 123 as unknown as string }) })
    expect(validatePrompt(body)).toBeNull()
  })

  it('rejects styles with a non-string value', () => {
    const body = fixtureBody({
      element: fixtureElement({ styles: { color: 1 as unknown as string } }),
    })
    expect(validatePrompt(body)).toBeNull()
  })

  it('rejects a rect with NaN', () => {
    const body = fixtureBody({
      element: fixtureElement({ rect: { x: NaN, y: 0, w: 10, h: 10 } }),
    })
    expect(validatePrompt(body)).toBeNull()
  })

  it('rejects a non-object body', () => {
    expect(validatePrompt('nope')).toBeNull()
    expect(validatePrompt(null)).toBeNull()
  })

  describe('extras', () => {
    it('accepts up to 4 valid extras', () => {
      const extras = [fixtureElement(), fixtureElement(), fixtureElement(), fixtureElement()]
      const body = fixtureBody({ extras })
      expect(validatePrompt(body)).toEqual(body)
    })

    it('accepts a single extra', () => {
      const body = fixtureBody({ extras: [fixtureElement({ path: 'body > a' })] })
      expect(validatePrompt(body)).toEqual(body)
    })

    it('rejects more than 4 extras', () => {
      const extras = [fixtureElement(), fixtureElement(), fixtureElement(), fixtureElement(), fixtureElement()]
      expect(validatePrompt(fixtureBody({ extras }))).toBeNull()
    })

    it('rejects extras that is not an array', () => {
      const body = { ...fixtureBody(), extras: fixtureElement() }
      expect(validatePrompt(body)).toBeNull()
    })

    it('rejects extras containing an invalid element', () => {
      const extras = [fixtureElement(), fixtureElement({ hint: 123 as unknown as string })]
      expect(validatePrompt(fixtureBody({ extras }))).toBeNull()
    })

    it('omits extras from the result when not provided', () => {
      const result = validatePrompt(fixtureBody())
      expect(result).not.toBeNull()
      expect(result?.extras).toBeUndefined()
    })
  })

  describe('screenshotPng', () => {
    it('accepts a valid base64 string', () => {
      const body = fixtureBody({ screenshotPng: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' })
      expect(validatePrompt(body)).toEqual(body)
    })

    it('omits screenshotPng from the result when not provided', () => {
      const result = validatePrompt(fixtureBody())
      expect(result).not.toBeNull()
      expect(result?.screenshotPng).toBeUndefined()
    })

    it('rejects a non-string screenshotPng', () => {
      expect(validatePrompt(fixtureBody({ screenshotPng: 123 as unknown as string }))).toBeNull()
    })

    it('rejects screenshotPng with invalid base64 characters', () => {
      expect(validatePrompt(fixtureBody({ screenshotPng: 'invalid@#$' }))).toBeNull()
    })

    it('rejects screenshotPng longer than 8_000_000 characters', () => {
      const tooLong = 'a'.repeat(8_000_001)
      expect(validatePrompt(fixtureBody({ screenshotPng: tooLong }))).toBeNull()
    })

    it('accepts a maximum-length valid base64 string', () => {
      const maxLength = 'A'.repeat(8_000_000)
      expect(validatePrompt(fixtureBody({ screenshotPng: maxLength }))).not.toBeNull()
    })

    it('accepts valid base64 padding variations', () => {
      expect(validatePrompt(fixtureBody({ screenshotPng: 'YQ==' }))).not.toBeNull()
      expect(validatePrompt(fixtureBody({ screenshotPng: 'YWI=' }))).not.toBeNull()
      expect(validatePrompt(fixtureBody({ screenshotPng: 'YWJj' }))).not.toBeNull()
    })
  })
})

describe('validateSpawn', () => {
  it('accepts mode "here"', () => {
    const result = validateSpawn({ mode: 'here' })
    expect(result).toEqual({ mode: 'here' })
  })

  it('accepts mode "worktree"', () => {
    const result = validateSpawn({ mode: 'worktree' })
    expect(result).toEqual({ mode: 'worktree' })
  })

  it('rejects invalid mode', () => {
    expect(validateSpawn({ mode: 'invalid' })).toBeNull()
    expect(validateSpawn({ mode: 'HERE' })).toBeNull()
  })

  it('rejects when mode is missing', () => {
    expect(validateSpawn({})).toBeNull()
  })

  it('accepts optional name matching pattern', () => {
    const result = validateSpawn({ mode: 'here', name: 'my-agent' })
    expect(result).toEqual({ mode: 'here', name: 'my-agent' })
  })

  it('rejects name with uppercase letters', () => {
    expect(validateSpawn({ mode: 'here', name: 'MyAgent' })).toBeNull()
  })

  it('rejects name starting with uppercase', () => {
    expect(validateSpawn({ mode: 'here', name: 'A-agent' })).toBeNull()
  })

  it('rejects name with invalid characters', () => {
    expect(validateSpawn({ mode: 'here', name: 'my agent' })).toBeNull()
    expect(validateSpawn({ mode: 'here', name: 'my.agent' })).toBeNull()
  })

  it('accepts name with hyphens, underscores, and digits', () => {
    const result = validateSpawn({ mode: 'here', name: 'a1_b-c' })
    expect(result?.name).toBe('a1_b-c')
  })

  it('rejects name over 32 characters', () => {
    expect(validateSpawn({ mode: 'here', name: 'a'.repeat(33) })).toBeNull()
  })

  it('accepts name of exactly 32 characters', () => {
    const result = validateSpawn({ mode: 'here', name: 'a'.repeat(32) })
    expect(result?.name).toBe('a'.repeat(32))
  })

  it('accepts optional branch', () => {
    const result = validateSpawn({ mode: 'worktree', branch: 'feature/my-branch' })
    expect(result).toEqual({ mode: 'worktree', branch: 'feature/my-branch' })
  })

  it('rejects branch with whitespace', () => {
    expect(validateSpawn({ mode: 'worktree', branch: 'feature branch' })).toBeNull()
    expect(validateSpawn({ mode: 'worktree', branch: 'feature\nbranch' })).toBeNull()
  })

  it('rejects empty branch', () => {
    expect(validateSpawn({ mode: 'worktree', branch: '' })).toBeNull()
  })

  it('rejects branch over 100 characters', () => {
    expect(validateSpawn({ mode: 'worktree', branch: 'a'.repeat(101) })).toBeNull()
  })

  it('accepts branch of exactly 100 characters', () => {
    const result = validateSpawn({ mode: 'worktree', branch: 'a'.repeat(100) })
    expect(result?.branch).toBe('a'.repeat(100))
  })

  it('accepts both name and branch', () => {
    const result = validateSpawn({ mode: 'here', name: 'my-agent', branch: 'feature/foo' })
    expect(result).toEqual({ mode: 'here', name: 'my-agent', branch: 'feature/foo' })
  })

  it('rejects non-object body', () => {
    expect(validateSpawn('nope')).toBeNull()
    expect(validateSpawn(null)).toBeNull()
    expect(validateSpawn(123)).toBeNull()
  })
})
