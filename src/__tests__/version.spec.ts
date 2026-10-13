import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const readJson = (path: string): { version?: unknown } =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { version?: unknown }

describe('versions', () => {
  // release.yml also checks both against the tag; this catches a forgotten bump in every PR
  it('extension/manifest.json carries the package.json version', () => {
    expect(readJson('../../extension/manifest.json').version).toBe(readJson('../../package.json').version)
  })
})
