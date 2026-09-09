import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserContext, Page } from '@playwright/test'
import { chromium, expect } from '@playwright/test'
import { extensionIdFromKey, hostManifest, wrapperScript } from '../../src/cli.ts'
import { HOST_NAME } from '../../src/host-name.ts'
import type { FakeCmux } from '../../src/__tests__/helpers/fake-cmux.ts'
import { startFakeCmux } from '../../src/__tests__/helpers/fake-cmux.ts'

const EXTENSION_ID = extensionIdFromKey(
  (JSON.parse(readFileSync(fileURLToPath(new URL('../../extension/manifest.json', import.meta.url)), 'utf8')) as { key: string }).key,
)

export interface RawReceived {
  method: string
  params: Record<string, unknown>
}

export interface Harness {
  context: BrowserContext
  page: Page
  fake: FakeCmux
  sentPrompts(): { target: string; text: string }[]
  raw(): RawReceived[]
  close(): Promise<void>
}

const FIXTURE_HTML = `<!doctype html><html><head><title>pick</title><style>body{margin:40px;font:16px sans-serif}.btn{padding:8px 16px;background:#6e56cf;color:#fff;border:0;border-radius:6px}</style></head><body><main><h1>Settings</h1><form class="settings"><label>Name <input id="name" value="Marco"></label><p class="note"><span class="note-text">Saved locally</span></p><button id="save" class="btn btn-primary" type="button">Save</button></form></main></body></html>`

export async function launchExtension(opts: {
  snapshot: (received: RawReceived[]) => unknown
  handlers?: Record<string, (params: Record<string, unknown>) => unknown>
  installHost?: boolean
  html?: string
}): Promise<Harness> {
  // Assert that the extension is built
  const dist = fileURLToPath(new URL('../../dist/', import.meta.url))
  const extensionDist = join(dist, 'extension')
  const manifestPath = join(extensionDist, 'manifest.json')
  const hostJsPath = join(dist, 'host.js')

  if (!existsSync(manifestPath)) {
    throw new Error('run npm run build before the e2e')
  }
  if (!existsSync(hostJsPath)) {
    throw new Error('run npm run build before the e2e')
  }

  // Start fake cmux
  const fake = await startFakeCmux({
    'session.snapshot': () => opts.snapshot(fake.received),
    'agent.prompt': (params) => ({
      type: 'agent_prompted',
      agent: { pane_id: params.target, terminal_title_stripped: 'Settings polish' },
    }),
    ...opts.handlers,
  })

  // Setup temp dir and profile
  const tempDir = tmpdir()
  const testDir = `${tempDir}/cmux-picker-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  mkdirSync(testDir, { recursive: true })

  const userDataDir = join(testDir, 'profile')
  mkdirSync(userDataDir, { recursive: true })

  // Copy and patch extension
  const extDir = join(testDir, 'ext')
  cpSync(extensionDist, extDir, { recursive: true })

  // Patch manifest to add host_permissions
  const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'))
  manifest.host_permissions = ['<all_urls>']
  writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest))

  // Setup native host if requested
  if (opts.installHost !== false) {
    const hostShPath = join(testDir, 'host.sh')
    const wrapper = wrapperScript({
      nodePath: process.execPath,
      hostJs: hostJsPath,
      socketPath: fake.socketPath,
    })
    writeFileSync(hostShPath, wrapper, 'utf8')
    chmodSync(hostShPath, 0o755)

    const nativeMessagingHostsDir = join(userDataDir, 'NativeMessagingHosts')
    mkdirSync(nativeMessagingHostsDir, { recursive: true })

    const manifestJson = hostManifest({ hostScript: hostShPath, extensionId: EXTENSION_ID })
    writeFileSync(
      join(nativeMessagingHostsDir, `${HOST_NAME}.json`),
      JSON.stringify(manifestJson),
      'utf8',
    )
  }

  // Launch browser
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  })

  // Setup route for test page
  await context.route('http://127.0.0.1/**', (route) => {
    route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: opts.html ?? FIXTURE_HTML,
    })
  })

  // Create page and navigate
  const page = await context.newPage()
  await page.goto('http://127.0.0.1/pick.html')

  // Return harness
  return {
    context,
    page,
    fake,
    sentPrompts() {
      return fake.received
        .filter((msg) => msg.method === 'agent.prompt')
        .map((msg) => ({
          target: String(msg.params.target ?? ''),
          text: String(msg.params.text ?? ''),
        }))
    },
    raw() {
      return fake.received
    },
    async close() {
      await context.close()
      await fake.close()
      // Clean up temp dir
      const fs = await import('node:fs/promises')
      await fs.rm(testDir, { recursive: true, force: true })
    },
  }
}

export async function triggerPick(context: BrowserContext, page: Page): Promise<void> {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))

  const tabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1/*' })
    return tabs[0]?.id
  })

  if (tabId === undefined) {
    throw new Error('Could not find tab with test URL')
  }

  await sw.evaluate((id) => {
    return (globalThis as unknown as { __cmuxPick(id: number): Promise<void> }).__cmuxPick(id)
  }, tabId)

  await expect(page.locator('[data-cmux-host]')).toBeAttached()
}

export async function pickSaveButton(page: Page): Promise<void> {
  const saveButton = page.locator('#save')
  const boundingBox = await saveButton.boundingBox()

  if (!boundingBox) {
    throw new Error('Save button not found or not visible')
  }

  const centerX = boundingBox.x + boundingBox.width / 2
  const centerY = boundingBox.y + boundingBox.height / 2

  await page.mouse.move(centerX, centerY)
  await page.mouse.click(centerX, centerY)

  await expect(page.locator('[data-cmux-host] .popup')).toBeVisible()
}

export function liveSnapshot(status: 'idle' | 'working'): unknown {
  return {
    type: 'session_snapshot',
    snapshot: {
      version: '0.8.2',
      protocol: 20,
      focused_workspace_id: 'w1',
      focused_pane_id: 'w1:p1',
      workspaces: [{ workspace_id: 'w1', label: 'app', number: 1, focused: true }],
      tabs: [],
      panes: [{ pane_id: 'w1:p1', workspace_id: 'w1', focused: true, cwd: '/tmp/proj' }],
      layouts: [],
      agents: [
        {
          pane_id: 'w1:p2',
          workspace_id: 'w1',
          agent_status: status,
          focused: false,
          agent: 'claude',
          cwd: '/tmp/proj',
          terminal_title_stripped: 'Settings polish',
          tokens: { branch: 'main' },
          agent_session: { value: 's1' },
        },
      ],
    },
  }
}
