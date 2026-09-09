import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const root = fileURLToPath(new URL('..', import.meta.url))

// npm links the bin to dist/cli.js as-is: without its shebang the shell runs
// the bundle as a script. Pack and install the way npx does, then run the link.
test('the packed CLI runs through its bin link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cmux-picker-pack-'))
  const tarball = execFileSync('npm', ['pack', '--pack-destination', dir, '--silent'], { cwd: root, encoding: 'utf8' }).trim()
  execFileSync('npm', ['install', '--prefix', dir, '--no-audit', '--no-fund', '--silent', join(dir, tarball)], { encoding: 'utf8' })

  const help = execFileSync(join(dir, 'node_modules/.bin/cmux-picker'), ['--help'], { encoding: 'utf8' })
  expect(help).toContain('install-host')
})
