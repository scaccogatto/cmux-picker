import { expect, test } from '@playwright/test'
import { readFileSync, statSync } from 'node:fs'
import type { Harness } from './helpers/extension.ts'
import { DEFAULT_SURFACE_ID, DEFAULT_WORKSPACE_ID, launchExtension, triggerPick, pickSaveButton } from './helpers/extension.ts'

let harness: Harness | undefined

test.afterEach(async () => {
  if (harness) {
    await harness.close()
    harness = undefined
  }
})

test('sends the picked element to the agent and shows DONE', async () => {
  harness = await launchExtension({})

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
    expect(prompt.workspace_id).toBe(DEFAULT_WORKSPACE_ID)
    expect(prompt.surface_id).toBe(DEFAULT_SURFACE_ID)
    expect(prompt.submit_key).toBe('return')
    expect(prompt.text.startsWith('[cmux-picker] http://')).toBe(true)
    expect(prompt.text).toContain('Focus: none, find by selector')
    expect(prompt.text).toContain('Element: button#save')
    expect(prompt.text).toContain('data-cmux-picked=""')
    expect(prompt.text).toMatch(/---\nMake it green$/)
  }

  // Wait for DONE chip
  await expect(page.locator('[data-cmux-host] .inflight-chip.done')).toBeVisible({ timeout: 10_000 })
})

test('attaches a real-pixel screenshot when the switch is on', async () => {
  harness = await launchExtension({})

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

test('a submitted:false reply shows the press-enter toast and clears the in-flight poll', async () => {
  harness = await launchExtension({
    handlers: {
      // cmux left the text sitting unsubmitted at the prompt: no lifecycle transition will ever
      // follow, so this must surface immediately rather than waiting on a poll that never settles.
      'terminal.paste': (params) => ({
        workspace_id: params.workspace_id,
        surface_id: params.surface_id,
        submitted: false,
        submit_error: 'no active turn',
      }),
    },
  })

  const { page } = harness

  await triggerPick(harness.context, page)
  await pickSaveButton(page)

  await expect(page.locator('[data-cmux-host] .popup textarea')).toBeFocused({ timeout: 5000 })
  // Wait for agents to load: sending before then would hit the empty-state clipboard fallback
  // instead of exercising the cmux path this test is about.
  await expect(page.locator('[data-cmux-host] .shot-row')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-cmux-host] .popup textarea').fill('Make it green')
  await page.locator('[data-cmux-host] .send-btn').click()

  await expect.poll(() => harness!.sentPrompts().length).toBe(1)

  await expect(page.locator('[data-cmux-host] .toast')).toContainText('press Enter there to send it', { timeout: 5000 })
  await expect(page.locator('[data-cmux-host] .toast')).toContainText('no active turn')

  // The pane was cleared back out of in-flight tracking: a retry would double-paste, so no poll runs.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __cmux?: { inflight(): string | null } }).__cmux?.inflight() ?? null))
    .toBeNull()
  await expect(page.locator('[data-cmux-host] .inflight-chip')).not.toBeVisible()
})

test('falls back to the clipboard notice when the native host is not installed', async () => {
  harness = await launchExtension({ installHost: false })

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
