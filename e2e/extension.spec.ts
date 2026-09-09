import { expect, test } from '@playwright/test'
import { readFileSync, statSync } from 'node:fs'
import type { Harness } from './helpers/extension.ts'
import { launchExtension, triggerPick, pickSaveButton, liveSnapshot } from './helpers/extension.ts'

let harness: Harness | undefined

test.afterEach(async () => {
  if (harness) {
    await harness.close()
    harness = undefined
  }
})

test('sends the picked element to the agent and shows DONE', async () => {
  let snapshotsAfterPrompt = 0

  harness = await launchExtension({
    snapshot: (received) => {
      // Count snapshots after the first prompt
      const promptIndex = received.findIndex((msg) => msg.method === 'agent.prompt')
      if (promptIndex >= 0) {
        snapshotsAfterPrompt = received.filter((msg, i) => i > promptIndex && msg.method === 'session.snapshot').length
      }

      // Return working status until we have 2 snapshots after the prompt
      if (promptIndex < 0) {
        return liveSnapshot('working')
      }

      return snapshotsAfterPrompt >= 2 ? liveSnapshot('idle') : liveSnapshot('working')
    },
  })

  const { page } = harness

  // Trigger picker
  await triggerPick(harness.context, page)

  // Pick the save button
  await pickSaveButton(page)

  // Wait for textarea to be focused (indicates popup is ready)
  await expect(page.locator('[data-cmux-host] .popup textarea')).toBeFocused({ timeout: 5000 })

  // Wait for screenshot row to be visible (indicates state has been fetched)
  await expect(page.locator('[data-cmux-host] .shot-row')).toBeVisible({ timeout: 5000 })

  // Type prompt - textarea is already focused
  await page.locator('[data-cmux-host] .popup textarea').fill('Make it green')

  // Click the Send button (keyboard events might not be trusted in Playwright)
  await page.locator('[data-cmux-host] .send-btn').click()

  // Wait for prompt to be sent
  await expect.poll(() => harness!.sentPrompts().length).toBe(1)

  const prompts = harness.sentPrompts()
  const prompt = prompts[0]

  expect(prompt).toBeDefined()
  if (prompt) {
    expect(prompt.target).toBe('w1:p2')
    expect(prompt.text).toContain('[cmux-picker] http://127.0.0.1/pick.html')
    expect(prompt.text).toContain('Focus: none, find by selector')
    expect(prompt.text).toContain('Element: button#save')
    expect(prompt.text).toContain('data-cmux-picked=""')
    expect(prompt.text).toMatch(/---\nMake it green$/)
  }

  // Wait for DONE chip
  await expect(page.locator('[data-cmux-host] .inflight-chip.done')).toBeVisible({ timeout: 10_000 })
})

test('attaches a real-pixel screenshot when the switch is on', async () => {
  let snapshotsAfterPrompt = 0

  harness = await launchExtension({
    snapshot: (received) => {
      const promptIndex = received.findIndex((msg) => msg.method === 'agent.prompt')
      if (promptIndex >= 0) {
        snapshotsAfterPrompt = received.filter((msg, i) => i > promptIndex && msg.method === 'session.snapshot').length
      }

      if (promptIndex < 0) {
        return liveSnapshot('working')
      }

      return snapshotsAfterPrompt >= 2 ? liveSnapshot('idle') : liveSnapshot('working')
    },
  })

  const { page } = harness

  // Trigger picker
  await triggerPick(harness.context, page)

  // Pick the save button
  await pickSaveButton(page)

  // Wait for textarea to be focused (indicates popup is ready)
  await expect(page.locator('[data-cmux-host] .popup textarea')).toBeFocused({ timeout: 5000 })

  // Check the screenshot checkbox (visible when state reports screenshot available)
  await expect(page.locator('[data-cmux-host] .shot-row input[type=checkbox]')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-cmux-host] .shot-row input[type=checkbox]').check()

  // Type prompt
  await page.locator('[data-cmux-host] .popup textarea').fill('Make it green')

  // Click the Send button
  await page.locator('[data-cmux-host] .send-btn').click()

  // Wait for prompt to be sent
  await expect.poll(() => harness!.sentPrompts().length).toBe(1)

  const prompts = harness.sentPrompts()
  const prompt = prompts[0]

  expect(prompt).toBeDefined()
  if (!prompt) return

  // Verify screenshot line is present
  const screenshotMatch = prompt.text.match(/^Screenshot: (\S+\.png) \(real pixels, the picked element is outlined, 40px margin\)$/m)
  expect(screenshotMatch).not.toBeNull()

  const screenshotPath = screenshotMatch?.[1]
  expect(screenshotPath).toBeDefined()

  // Verify screenshot file exists and is valid
  if (screenshotPath) {
    try {
      const stats = statSync(screenshotPath)
      expect(stats.size).toBeGreaterThan(100)

      // Check PNG magic bytes
      const buffer = readFileSync(screenshotPath)
      const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47])
      expect(buffer.subarray(0, 4).equals(pngMagic)).toBe(true)
    } catch (err) {
      throw new Error(`Screenshot file validation failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      })
    }
  }

  // Wait for DONE chip
  await expect(page.locator('[data-cmux-host] .inflight-chip.done')).toBeVisible({ timeout: 10_000 })
})

test('falls back to the clipboard notice when the native host is not installed', async () => {
  harness = await launchExtension({
    installHost: false,
    snapshot: () => liveSnapshot('idle'),
  })

  const { page } = harness

  // Trigger picker
  await triggerPick(harness.context, page)

  // Pick the save button
  await pickSaveButton(page)

  // Should show notice with no_host message
  await expect(page.locator('[data-cmux-host] .agents-notice')).toContainText('no_host')
})

test('content.js is a classic script', async () => {
  const contentJs = readFileSync(new URL('../dist/extension/content.js', import.meta.url), 'utf8')

  // Should not have import or export statements
  const hasModuleStatements = /^(import|export) /m.test(contentJs)
  expect(hasModuleStatements).toBe(false)

  // Should not have import.meta
  const hasImportMeta = /import\.meta/.test(contentJs)
  expect(hasImportMeta).toBe(false)
})
