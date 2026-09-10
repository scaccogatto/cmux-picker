#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_NAME } from './host-name.ts'

/**
 * Derives the extension ID from the public key: sha256 of the base64-decoded
 * key, first 16 bytes as 32 hex chars, each hex digit 0-9a-f mapped to a-p
 */
export function extensionIdFromKey(keyBase64: string): string {
  const keyBuffer = Buffer.from(keyBase64, 'base64')
  const hash = createHash('sha256').update(keyBuffer).digest()
  const first16 = hash.subarray(0, 16)
  const hex = first16.toString('hex')
  return hex.replace(/./g, (c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)))
}

/** Native messaging host manifest for Chrome */
export function hostManifest(opts: { hostScript: string; extensionId: string }): object {
  return {
    name: HOST_NAME,
    description: 'cmux-picker native messaging host',
    path: opts.hostScript,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${opts.extensionId}/`],
  }
}

/** Shell wrapper script that sets env and execs the host */
export function wrapperScript(opts: { nodePath: string; hostJs: string; socketPath?: string }): string {
  const lines: string[] = ['#!/bin/sh']

  if (opts.socketPath !== undefined) {
    lines.push(`export CMUX_SOCKET_PATH="${opts.socketPath.replace(/"/g, '\\"')}"`)
  }

  lines.push(`exec "${opts.nodePath}" "${opts.hostJs}"`)
  lines.push('')

  return lines.join('\n')
}

/**
 * Lists Chrome/Chromium native messaging hosts directories for the platform.
 * On macOS: Chrome and Chromium under Library/Application Support.
 * On Linux: google-chrome and chromium under XDG_CONFIG_HOME or ~/.config.
 * Other platforms: empty list.
 */
export function browserDirs(opts: { platform: string; home: string; env: NodeJS.ProcessEnv }): string[] {
  if (opts.platform === 'darwin') {
    return [
      join(opts.home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
      join(opts.home, 'Library/Application Support/Chromium/NativeMessagingHosts'),
    ]
  }

  if (opts.platform === 'linux') {
    const configHome = opts.env.XDG_CONFIG_HOME ?? join(opts.home, '.config')
    return [
      join(configHome, 'google-chrome/NativeMessagingHosts'),
      join(configHome, 'chromium/NativeMessagingHosts'),
    ]
  }

  return []
}

/** Config directory for cmux-picker, respecting XDG_CONFIG_HOME */
export function configDir(opts: { home: string; env: NodeJS.ProcessEnv }): string {
  const base = opts.env.XDG_CONFIG_HOME ?? join(opts.home, '.config')
  return join(base, 'cmux-picker')
}

/** Installs the host by copying it to config and registering it with browsers */
export async function installHost(opts: {
  hostSource: string
  configDir: string
  browserDirs: string[]
  forceBrowserDir?: string
  extensionId: string
  nodePath: string
  socketPath?: string
}): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = []
  const skipped: string[] = []

  // Create config dir and copy host.js
  await mkdir(opts.configDir, { recursive: true })
  const hostJsPath = join(opts.configDir, 'host.js')
  const hostShPath = join(opts.configDir, 'host.sh')

  const hostContent = await readFile(opts.hostSource)
  await writeFile(hostJsPath, hostContent)

  // Write wrapper script
  const wrapperContent = wrapperScript({
    nodePath: opts.nodePath,
    hostJs: hostJsPath,
    socketPath: opts.socketPath,
  })
  await writeFile(hostShPath, wrapperContent, 'utf8')
  await chmod(hostShPath, 0o755)

  written.push(hostJsPath)
  written.push(hostShPath)

  // Register with browsers
  const manifest = hostManifest({ hostScript: hostShPath, extensionId: opts.extensionId })
  const manifestJson = JSON.stringify(manifest, null, 2) + '\n'

  if (opts.forceBrowserDir !== undefined) {
    // Write to the forced directory only
    await mkdir(opts.forceBrowserDir, { recursive: true })
    const manifestPath = join(opts.forceBrowserDir, `${HOST_NAME}.json`)
    await writeFile(manifestPath, manifestJson, 'utf8')
    written.push(manifestPath)
  } else {
    // Write to directories where the browser profile parent exists, skip others
    for (const dir of opts.browserDirs) {
      const parent = dirname(dir)
      if (existsSync(parent)) {
        await mkdir(dir, { recursive: true })
        const manifestPath = join(dir, `${HOST_NAME}.json`)
        await writeFile(manifestPath, manifestJson, 'utf8')
        written.push(manifestPath)
      } else {
        skipped.push(dir)
      }
    }
  }

  return { written, skipped }
}

/** Parses CLI arguments and runs the install flow */
const USAGE = `cmux-picker install-host [--socket <path>] [--extension-id <id>] [--browser-dir <dir>]

Installs the native messaging host Chrome launches for the cmux picker extension:
  copies host.js to ~/.config/cmux-picker/ (XDG_CONFIG_HOME honoured), writes host.sh
  next to it, and registers it with every Chrome/Chromium profile found (or --browser-dir).
  The cmux control socket must allow external clients: set cmux Settings > Automation
  to "Automation mode" or "Password mode" (default "cmux processes only" will reject).
  --socket        bake CMUX_SOCKET_PATH into host.sh (named cmux sessions)
  --extension-id  override the id derived from the bundled extension manifest's key
  --browser-dir   write the host manifest into this NativeMessagingHosts directory only`

export async function main(argv: string[]): Promise<number> {
  // Handle --help/-h/no-args
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return 0
  }

  const command = argv[0]
  if (command !== 'install-host') {
    console.log(USAGE)
    return 1
  }

  // Parse flags
  let socketPath: string | undefined
  let extensionId: string | undefined
  let forceBrowserDir: string | undefined

  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--socket') {
      socketPath = argv[++i]
    } else if (argv[i] === '--extension-id') {
      extensionId = argv[++i]
    } else if (argv[i] === '--browser-dir') {
      forceBrowserDir = argv[++i]
    }
  }

  // Resolve paths and extension ID
  // Not `new URL('./host.js', import.meta.url)`: Vite treats that pattern as an asset reference and inlines the file
  const here = dirname(fileURLToPath(import.meta.url))
  const hostSource = join(here, 'host.js')
  const home = homedir()
  const nodePath = process.execPath

  // Try to get extension ID from manifest if not provided
  if (extensionId === undefined) {
    const manifestPath = join(here, 'extension', 'manifest.json')
    if (!existsSync(manifestPath)) {
      console.log(`cannot derive the extension id: ${manifestPath} not found; pass --extension-id`)
      return 1
    }
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      if (typeof manifest.key === 'string') {
        extensionId = extensionIdFromKey(manifest.key)
      } else {
        console.log(`cannot derive the extension id: ${manifestPath} has no key field; pass --extension-id`)
        return 1
      }
    } catch (err) {
      const message_str = err instanceof Error ? err.message : String(err)
      console.log(`cannot derive the extension id: ${message_str}; pass --extension-id`)
      return 1
    }
  }

  // Install
  const config = configDir({ home, env: process.env })
  const dirs = browserDirs({ platform: process.platform, home, env: process.env })

  const result = await installHost({
    hostSource,
    configDir: config,
    browserDirs: dirs,
    forceBrowserDir,
    extensionId,
    nodePath,
    socketPath,
  })

  // Report
  for (const path of result.written) {
    console.log(`wrote ${path}`)
  }

  for (const dir of result.skipped) {
    console.log(`skipped ${dir} (no profile)`)
  }

  if (result.written.length === 0) {
    console.log(`no Chrome or Chromium profile found; pass --browser-dir <NativeMessagingHosts dir>`)
    return 1
  }

  console.log(`Now load the extension and press Ctrl+B on any page. First ensure cmux Settings > Automation is set to "Automation mode" or "Password mode" (not default "cmux processes only").`)
  return 0
}

// Run main only when executed directly
// realpath: `npx cmux-picker` runs through a bin symlink, while import.meta.url is the resolved file
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
