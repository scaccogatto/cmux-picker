import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect, test } from '@playwright/test'
import type { Harness, HookSessionFixture, WorkspaceFixture } from './helpers/extension.ts'
import { launchExtension, triggerPick, pickSaveButton } from './helpers/extension.ts'

test.skip(!process.env.STORE_ASSETS, 'set STORE_ASSETS=1 to regenerate the Chrome Web Store assets')

const out = fileURLToPath(new URL('../store/', import.meta.url))
mkdirSync(out, { recursive: true })

const STORE_PAGE = `<!doctype html><html><head><title>Settings · Waves</title><style>
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#1c1c28;background:#f4f5f9}
header{height:56px;background:#fff;border-bottom:1px solid #e3e5ee;display:flex;align-items:center;padding:0 32px;gap:32px}
header b{font-size:17px}header nav a{color:#5a5d72;text-decoration:none;margin-right:20px}header nav a.on{color:#1c1c28;font-weight:600}
main{display:grid;grid-template-columns:220px 1fr;gap:32px;max-width:1040px;margin:40px auto;padding:0 32px}
aside a{display:block;padding:8px 12px;border-radius:8px;color:#5a5d72;text-decoration:none}aside a.on{background:#e9e6fb;color:#4a3ab8;font-weight:600}
.card{background:#fff;border:1px solid #e3e5ee;border-radius:12px;padding:28px 32px}
h1{font-size:22px;margin:0 0 4px}p.sub{margin:0 0 24px;color:#5a5d72}
label{display:block;font-size:13px;font-weight:600;margin:16px 0 6px}
input,select{width:100%;padding:10px 12px;border:1px solid #cfd2df;border-radius:8px;font:inherit;background:#fff}
.row{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.actions{display:flex;gap:12px;margin-top:28px;padding-top:20px;border-top:1px solid #e3e5ee}
.btn{padding:10px 18px;border-radius:8px;border:1px solid #cfd2df;background:#fff;font:inherit;font-weight:600;cursor:pointer}
.btn-primary{background:#6e56cf;border-color:#6e56cf;color:#fff}
</style></head><body>
<header><b>Waves</b><nav><a href="#">Projects</a><a href="#">Team</a><a href="#" class="on">Settings</a></nav></header>
<main><aside><a href="#" class="on">Profile</a><a href="#">Notifications</a><a href="#">Billing</a><a href="#">API keys</a></aside>
<section class="card"><h1>Profile</h1><p class="sub">How your teammates see you.</p>
<form class="settings"><div class="row"><div><label for="name">Full name</label><input id="name" value="Sam Rivera"></div><div><label for="email">Email</label><input id="email" value="sam@example.com"></div></div>
<label for="tz">Timezone</label><select id="tz"><option>Europe/Rome</option></select>
<label for="bio">Bio</label><input id="bio" placeholder="A line about you">
<div class="actions"><button id="save" class="btn btn-primary" type="button">Save changes</button><button class="btn" type="button">Cancel</button></div></form></section></main></body></html>`

// Two workspaces: "webapp" (focused, the one "+ agent here" would split) hosting a claude and a
// codex surface, and "api" hosting a second claude surface elsewhere.
const STORE_WORKSPACES: WorkspaceFixture[] = [
  {
    id: 'w1',
    title: 'webapp',
    index: 0,
    selected: true,
    currentDirectory: '/Users/sam/webapp',
    branch: 'feat/settings',
    surfaces: [
      { id: 'sf-claude-1', title: 'Settings page polish', focused: true },
      { id: 'sf-codex-1', title: 'Checkout redesign', focused: false },
    ],
  },
  {
    id: 'w2',
    title: 'api',
    index: 1,
    selected: false,
    currentDirectory: '/Users/sam/api',
    branch: 'main',
    surfaces: [{ id: 'sf-claude-2', title: 'Rate limiter', focused: false }],
  },
]

const STORE_HOOK_SESSIONS: HookSessionFixture[] = [
  { agent: 'claude', sessionId: 's1', workspaceId: 'w1', surfaceId: 'sf-claude-1', cwd: '/Users/sam/webapp', title: 'Settings page polish', lifecycle: 'idle' },
  { agent: 'codex', sessionId: 's2', workspaceId: 'w1', surfaceId: 'sf-codex-1', cwd: '/Users/sam/webapp', title: 'Checkout redesign', lifecycle: 'running' },
  { agent: 'claude', sessionId: 's3', workspaceId: 'w2', surfaceId: 'sf-claude-2', cwd: '/Users/sam/api', title: 'Rate limiter', lifecycle: 'idle' },
]

function pngSize(path: string): { w: number; h: number } {
  const buf = readFileSync(path)
  const w = buf.readUInt32BE(16)
  const h = buf.readUInt32BE(20)
  return { w, h }
}

let harness: Harness | undefined

test.afterEach(async () => {
  if (harness) {
    await harness.close()
    harness = undefined
  }
})

test('screenshots', async () => {
  harness = await launchExtension({ workspaces: STORE_WORKSPACES, hookSessions: STORE_HOOK_SESSIONS, html: STORE_PAGE })
  const { context, page } = harness

  await page.setViewportSize({ width: 1280, height: 800 })

  // Trigger picking mode
  await triggerPick(context, page)

  // Screenshot 1: hover over save button
  const saveButton = page.locator('#save')
  const bbox = await saveButton.boundingBox()
  if (!bbox) throw new Error('Save button not found')

  const centerX = bbox.x + bbox.width / 2
  const centerY = bbox.y + bbox.height / 2

  // Move mouse in two steps to ensure hover chip appears
  await page.mouse.move(centerX - 50, centerY)
  await page.mouse.move(centerX, centerY)

  // Wait for hover chip
  await expect(page.locator('[data-cmux-host] .chip')).toBeVisible({ timeout: 2000 })

  await page.screenshot({ path: join(out, 'screenshot-1.png') })
  const s1 = pngSize(join(out, 'screenshot-1.png'))
  expect(s1.w).toBe(1280)
  expect(s1.h).toBe(800)

  // Screenshot 2: click save and add prompt
  await pickSaveButton(page)

  // The popup shows "loading agents..." until the state arrives from the host; wait for the To row
  await expect(page.locator('[data-cmux-host] .to-row')).toBeVisible()
  const textarea = page.locator('[data-cmux-host] .popup textarea')
  await textarea.click()
  await textarea.pressSequentially('Make this button match our brand purple and show a loading state while saving')
  await page.screenshot({ path: join(out, 'screenshot-2.png') })
  const s2 = pngSize(join(out, 'screenshot-2.png'))
  expect(s2.w).toBe(1280)
  expect(s2.h).toBe(800)

  // Screenshot 3: open agents list
  await page.locator('[data-cmux-host] .to-row').click()
  await expect(page.locator('[data-cmux-host] .agents-groups')).toBeVisible()
  await page.screenshot({ path: join(out, 'screenshot-3.png') })
  const s3 = pngSize(join(out, 'screenshot-3.png'))
  expect(s3.w).toBe(1280)
  expect(s3.h).toBe(800)
})

test('promo tile and store icon', async () => {
  const iconBase64 = readFileSync(new URL('../extension/icons/icon-128.png', import.meta.url)).toString('base64')
  const browser = await chromium.launch()

  // Tile screenshot
  const tilePage = await browser.newPage()
  await tilePage.setViewportSize({ width: 440, height: 280 })

  const TILE_HTML = `<!doctype html><html><head><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1f1e2e; display: flex; align-items: center; justify-content: center; width: 440px; height: 280px; font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  .container { display: flex; align-items: center; gap: 20px; }
  .icon { width: 96px; height: 96px; flex-shrink: 0; }
  .text { display: flex; flex-direction: column; gap: 4px; }
  .title { color: #fff; font-size: 28px; font-weight: 600; }
  .tagline { color: #b9b6d6; font-size: 15px; }
  </style></head><body>
  <div class="container">
    <img class="icon" src="data:image/png;base64,${iconBase64}" alt="cmux picker">
    <div class="text">
      <div class="title">cmux picker</div>
      <div class="tagline">Pick an element, send it to your agent</div>
    </div>
  </div>
  </body></html>`

  await tilePage.setContent(TILE_HTML)
  await tilePage.screenshot({ path: join(out, 'tile-440x280.png') })
  const tile = pngSize(join(out, 'tile-440x280.png'))
  expect(tile.w).toBe(440)
  expect(tile.h).toBe(280)

  // Icon screenshot
  const iconPage = await browser.newPage()
  await iconPage.setViewportSize({ width: 128, height: 128 })

  const ICON_HTML = `<!doctype html><html><head><style>
  * { margin: 0; padding: 0; }
  body { margin: 0; background: transparent; width: 128px; height: 128px; display: flex; align-items: center; justify-content: center; }
  img { width: 96px; height: 96px; }
  </style></head><body>
  <img src="data:image/png;base64,${iconBase64}" alt="cmux">
  </body></html>`

  await iconPage.setContent(ICON_HTML)
  await iconPage.screenshot({ path: join(out, 'icon-128.png'), omitBackground: true })
  const icon = pngSize(join(out, 'icon-128.png'))
  expect(icon.w).toBe(128)
  expect(icon.h).toBe(128)

  await tilePage.close()
  await iconPage.close()
  await browser.close()
})
