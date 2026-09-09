import type { ElementInfo, PromptRequest, SpawnRequest } from './types.ts'

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

/** Max number of extra elements accepted alongside `element` on a prompt request */
const MAX_EXTRAS = 4

/** Validates an untrusted value against the ElementInfo shape, returning null when it does not match */
export function validateElement(x: unknown): ElementInfo | null {
  if (!isPlainObject(x)) return null

  const { url, path, html, hint, viewport, rect, styles } = x
  if (typeof url !== 'string') return null
  if (typeof path !== 'string') return null
  if (typeof html !== 'string') return null
  if (hint !== null && typeof hint !== 'string') return null

  if (!isPlainObject(viewport) || !isFiniteNumber(viewport.w) || !isFiniteNumber(viewport.h)) return null

  if (
    !isPlainObject(rect) ||
    !isFiniteNumber(rect.x) ||
    !isFiniteNumber(rect.y) ||
    !isFiniteNumber(rect.w) ||
    !isFiniteNumber(rect.h)
  ) {
    return null
  }

  if (!isPlainObject(styles)) return null
  for (const value of Object.values(styles)) {
    if (typeof value !== 'string') return null
  }

  return {
    url,
    path,
    html,
    hint,
    viewport: { w: viewport.w, h: viewport.h },
    rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
    styles: styles as Record<string, string>,
  }
}

/**
 * Validates an untrusted request body against the PromptRequest shape,
 * returning null (never throwing) when it does not match
 */
export function validatePrompt(body: unknown): PromptRequest | null {
  if (!isPlainObject(body)) return null

  const { target, prompt, element, extras, screenshotPng } = body
  if (typeof target !== 'string' || target.length === 0) return null
  if (typeof prompt !== 'string' || prompt.length > 20000) return null

  const validatedElement = validateElement(element)
  if (validatedElement === null) return null

  const result: PromptRequest = { target, prompt, element: validatedElement }

  if (extras !== undefined) {
    if (!Array.isArray(extras) || extras.length > MAX_EXTRAS) return null

    const validatedExtras: ElementInfo[] = []
    for (const item of extras) {
      const validatedItem = validateElement(item)
      if (validatedItem === null) return null
      validatedExtras.push(validatedItem)
    }
    result.extras = validatedExtras
  }

  if (screenshotPng !== undefined) {
    if (typeof screenshotPng !== 'string') return null
    if (screenshotPng.length > 8_000_000) return null
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(screenshotPng)) return null
    result.screenshotPng = screenshotPng
  }

  return result
}

/**
 * Validates an untrusted request body against the SpawnRequest shape,
 * returning null (never throwing) when it does not match
 */
export function validateSpawn(body: unknown): SpawnRequest | null {
  const record = isPlainObject(body) ? body : null
  if (!record) return null

  const mode = record.mode
  if (mode !== 'here' && mode !== 'worktree') return null

  const spawn: SpawnRequest = { mode }

  if (record.name !== undefined) {
    if (typeof record.name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(record.name)) return null
    spawn.name = record.name
  }

  if (record.branch !== undefined) {
    if (typeof record.branch !== 'string' || record.branch.length === 0 || record.branch.length > 100 || /\s/.test(record.branch)) {
      return null
    }
    spawn.branch = record.branch
  }

  return spawn
}
