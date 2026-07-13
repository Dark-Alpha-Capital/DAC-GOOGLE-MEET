import puppeteer, { type Browser, type Page } from 'puppeteer-core'

import type { JoinPayload } from './types.js'

const CHROME_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'

async function clickByText(page: Page, texts: string[]) {
  const lowered = texts.map((t) => t.toLowerCase())
  const handles = await page.$$('button, div[role="button"], span[role="button"]')
  for (const handle of handles) {
    const text = (await page.evaluate((el) => el.textContent || '', handle))
      .trim()
      .toLowerCase()
    if (lowered.some((needle) => text.includes(needle))) {
      await handle.click()
      return true
    }
  }
  return false
}

async function dismissPermissionPrompts(page: Page) {
  await clickByText(page, ['got it', 'dismiss', 'continue without'])
}

async function fillGuestName(page: Page, displayName: string) {
  const selectors = [
    'input[aria-label*="name" i]',
    'input[placeholder*="name" i]',
    'input[type="text"]',
  ]
  for (const selector of selectors) {
    const input = await page.$(selector)
    if (!input) continue
    await input.click({ clickCount: 3 })
    await input.type(displayName, { delay: 20 })
    return true
  }
  return false
}

async function turnOffMedia(page: Page) {
  // Best-effort mute mic/cam before joining.
  await clickByText(page, ['turn off microphone', 'turn off camera'])
  await page.keyboard.down('Control')
  await page.keyboard.press('KeyD').catch(() => undefined)
  await page.keyboard.press('KeyE').catch(() => undefined)
  await page.keyboard.up('Control')
}

async function askToJoin(page: Page) {
  const joined = await clickByText(page, [
    'ask to join',
    'join now',
    'request to join',
    'join',
  ])
  if (!joined) {
    throw new Error('Could not find Ask to join / Join button')
  }
}

async function isWaitingForHost(page: Page) {
  const body = ((await page.evaluate(() => document.body?.innerText || '')) || '')
    .toLowerCase()
  return (
    body.includes('asking to join') ||
    body.includes('asking to be let in') ||
    body.includes('waiting for the host') ||
    body.includes('you will join the call when someone lets you in')
  )
}

async function isInMeeting(page: Page) {
  const body = ((await page.evaluate(() => document.body?.innerText || '')) || '')
    .toLowerCase()
  // Heuristics: leave call controls present and lobby messaging gone.
  const hasLeave =
    body.includes('leave call') ||
    body.includes('people') ||
    (await page.$('[aria-label*="Leave call" i]')) !== null
  const stillLobby = await isWaitingForHost(page)
  return hasLeave && !stillLobby
}

export class MeetGuestSession {
  private browser: Browser | null = null
  private page: Page | null = null

  async start(payload: JoinPayload) {
    this.browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--alsa-output-device=pulse',
        '--window-size=1280,720',
      ],
      defaultViewport: { width: 1280, height: 720 },
    })

    this.page = await this.browser.newPage()
    await this.page.goto(payload.meetLink, {
      waitUntil: 'networkidle2',
      timeout: 120_000,
    })

    await dismissPermissionPrompts(this.page)
    await fillGuestName(this.page, payload.displayName)
    await turnOffMedia(this.page)
    await askToJoin(this.page)
  }

  async waitForAdmission(timeoutMs: number): Promise<'waiting' | 'joined'> {
    if (!this.page) throw new Error('Session not started')

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await isInMeeting(this.page)) return 'joined'
      if (await isWaitingForHost(this.page)) {
        // stay in loop
      }
      await new Promise((r) => setTimeout(r, 2000))
    }

    if (await isInMeeting(this.page)) return 'joined'
    return 'waiting'
  }

  async waitUntilMeetingEnds(endsAtMs: number) {
    if (!this.page) throw new Error('Session not started')

    while (Date.now() < endsAtMs + 60_000) {
      const body = (
        (await this.page.evaluate(() => document.body?.innerText || '')) || ''
      ).toLowerCase()
      if (
        body.includes('you left the meeting') ||
        body.includes('rejoin') ||
        body.includes("you've been removed")
      ) {
        return
      }
      await new Promise((r) => setTimeout(r, 5000))
    }
  }

  async leave() {
    if (!this.page) return
    await clickByText(this.page, ['leave call', 'leave meeting', 'leave'])
  }

  async close() {
    try {
      await this.browser?.close()
    } catch {
      // ignore
    }
    this.browser = null
    this.page = null
  }
}
