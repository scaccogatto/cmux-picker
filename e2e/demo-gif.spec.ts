import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Harness, HookSessionFixture, WorkspaceFixture } from './helpers/extension.ts'
import { launchExtension, triggerPick } from './helpers/extension.ts'

/**
 * Records README.md's hero GIF: the whole loop, end to end, against a fake cmux
 * socket (the real extension, the real content script, the real native host,
 * a stand-in for cmux itself so the capture is reproducible on any machine).
 *
 *   npm run demo:gif
 *
 * Needs ffmpeg on PATH for the webm -> gif conversion.
 */
test.skip(!process.env.DEMO_GIF, 'set DEMO_GIF=1 (npm run demo:gif) to re-record .github/demo.gif')

test.setTimeout(180_000)

const VIEWPORT = { width: 1280, height: 800 }
const GIF_WIDTH = 800
const FPS = 12

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const videoDir = join(repoRoot, '.demo-capture')
const gifPath = join(repoRoot, '.github', 'demo.gif')

const DEMO_PAGE = `<!doctype html><html><head><title>Settings · Waves</title><style>
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

/** Two cmux workspaces, three live agent surfaces, so the popup shows a real choice. */
const WORKSPACES: WorkspaceFixture[] = [
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

const HOOK_SESSIONS: HookSessionFixture[] = [
  { agent: 'claude', sessionId: 's1', workspaceId: 'w1', surfaceId: 'sf-claude-1', cwd: '/Users/sam/webapp', title: 'Settings page polish', lifecycle: 'idle' },
  { agent: 'codex', sessionId: 's2', workspaceId: 'w1', surfaceId: 'sf-codex-1', cwd: '/Users/sam/webapp', title: 'Checkout redesign', lifecycle: 'running' },
  { agent: 'claude', sessionId: 's3', workspaceId: 'w2', surfaceId: 'sf-claude-2', cwd: '/Users/sam/api', title: 'Rate limiter', lifecycle: 'idle' },
]

/** webm -> gif with a per-clip palette; a shared palette is what keeps a UI capture from banding. */
function toGif(webm: string, out: string): void {
  const filters = `fps=${FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`
  const palette = join(videoDir, 'palette.png')
  execFileSync('ffmpeg', ['-y', '-i', webm, '-vf', `${filters},palettegen=stats_mode=diff`, palette], { stdio: 'inherit' })
  execFileSync(
    'ffmpeg',
    ['-y', '-i', webm, '-i', palette, '-lavfi', `${filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`, out],
    { stdio: 'inherit' },
  )
}

let harness: Harness | undefined

test.afterEach(async () => {
  if (harness) {
    await harness.close()
    harness = undefined
  }
})

test('record the hero gif', async () => {
  rmSync(videoDir, { recursive: true, force: true })
  mkdirSync(videoDir, { recursive: true })

  harness = await launchExtension({
    workspaces: WORKSPACES,
    hookSessions: HOOK_SESSIONS,
    html: DEMO_PAGE,
    recordVideo: { dir: videoDir, size: VIEWPORT },
  })
  const { context, page } = harness

  const host = page.locator('[data-cmux-host]')

  // 1. The page, before anything happens.
  await page.waitForTimeout(700)

  // 2. Ctrl+B arms the picker (the shortcut reaches the service worker, which
  //    injects the content script; Playwright cannot press a browser command).
  await triggerPick(context, page)
  await page.waitForTimeout(300)

  // 3. Hover: the highlight and the chip follow the cursor.
  const path: { x: number; y: number }[] = []
  const at = async (selector: string) => {
    const box = await page.locator(selector).boundingBox()
    if (!box) throw new Error(`no box for ${selector}`)
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  path.push(await at('header nav a.on'), await at('#name'), await at('#save'))

  await page.mouse.move(path[0]!.x, path[0]!.y, { steps: 20 })
  await page.waitForTimeout(350)
  await page.mouse.move(path[1]!.x, path[1]!.y, { steps: 25 })
  await page.waitForTimeout(400)
  await page.mouse.move(path[2]!.x, path[2]!.y, { steps: 25 })
  await expect(host.locator('.chip')).toBeVisible()
  await page.waitForTimeout(600)

  // 4. Click picks the element and opens the popup.
  await page.mouse.click(path[2]!.x, path[2]!.y)
  await expect(host.locator('.popup')).toBeVisible()
  await expect(host.locator('.to-row')).toBeVisible()
  await page.waitForTimeout(500)

  // 5. Type the fix.
  const textarea = host.locator('.popup textarea')
  await textarea.click()
  await textarea.pressSequentially('Make this the brand purple, add a saving spinner', { delay: 40 })
  await page.waitForTimeout(500)

  // 6. Open the agent list: every live cmux session, grouped by workspace,
  //    with its status, plus the two spawn rows.
  await host.locator('.to-row').click()
  await expect(host.locator('.agents-groups')).toBeVisible()
  await page.waitForTimeout(1300)

  // 7. Choose one that is not the preselected default: the point of the tool.
  await host.locator('.agent-row', { hasText: 'Rate limiter' }).click()
  await page.waitForTimeout(700)

  // 8. Send. The dashed in-flight outline stays on the element until the agent
  //    settles, then turns solid green.
  await page.keyboard.press('Enter')
  await expect(host.locator('.inflight')).toBeVisible()
  await expect(host.locator('.inflight.done')).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(1500)

  const videoPath = await page.video()?.path()
  if (videoPath === undefined) throw new Error('no video recorded')

  await harness.close()
  harness = undefined

  // page.video(), not the newest file in the directory: launchPersistentContext
  // also records its initial about:blank page, and that one is blank.
  toGif(videoPath, gifPath)
  const bytes = statSync(gifPath).size
  console.log(`wrote ${gifPath} (${(bytes / 1024 / 1024).toFixed(2)} MB) from ${videoPath}`)
  expect(bytes).toBeGreaterThan(50_000)
  expect(bytes).toBeLessThan(6_000_000)
})
