import fs from 'node:fs'
import path from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'

import type { JoinPayload } from './types.js'

function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH
  }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? '/usr/bin/chromium'
}

const CHROME_PATH = resolveChromePath()

/** Headed on macOS/local by default — Meet often breaks in headless. */
function shouldRunHeaded() {
  if (process.env.BOT_HEADED === '1') return true
  if (process.env.BOT_HEADED === '0') return false
  return process.platform === 'darwin' && !fs.existsSync('/.dockerenv')
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms))
}

async function clickByText(page: Page, texts: string[]) {
  const lowered = texts.map((t) => t.toLowerCase())
  return page.evaluate((needles) => {
    const nodes = Array.from(
      document.querySelectorAll(
        'button, div[role="button"], span[role="button"], a[role="button"]',
      ),
    )
    for (const el of nodes) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
      if (!text) continue
      if (needles.some((needle) => text === needle || text.includes(needle))) {
        ;(el as HTMLElement).click()
        return text
      }
    }
    return null
  }, lowered)
}

async function waitAndClick(
  page: Page,
  texts: string[],
  attempts = 15,
  delayMs = 1000,
) {
  for (let i = 0; i < attempts; i++) {
    const clicked = await clickByText(page, texts)
    if (clicked) {
      console.log(`[meet] clicked: "${clicked}"`)
      return true
    }
    await sleep(delayMs)
  }
  return false
}

async function dismissNoise(page: Page) {
  await waitAndClick(
    page,
    [
      'got it',
      'dismiss',
      'accept all',
      'i agree',
      'continue without an account',
      'continue as guest',
      "don't sign in",
      'use the browser',
      'join from your browser',
    ],
    3,
    800,
  )
}

async function fillGuestName(page: Page, displayName: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const filled = await page.evaluate((name) => {
      const selectors = [
        'input[aria-label*="name" i]',
        'input[placeholder*="name" i]',
        'input[type="text"]',
        'input[autocomplete="name"]',
      ]
      for (const selector of selectors) {
        const input = document.querySelector(selector) as HTMLInputElement | null
        if (!input || input.offsetParent === null) continue
        input.focus()
        input.value = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.value = name
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      }
      return false
    }, displayName)

    if (filled) {
      // Also type via CDP for frameworks that ignore .value
      const handle =
        (await page.$('input[aria-label*="name" i]')) ||
        (await page.$('input[placeholder*="name" i]')) ||
        (await page.$('input[type="text"]'))
      if (handle) {
        await handle.click({ clickCount: 3 })
        await handle.type(displayName, { delay: 15 })
      }
      console.log(`[meet] filled guest name: ${displayName}`)
      return true
    }
    await sleep(800)
  }
  return false
}

async function turnOffMedia(page: Page) {
  await waitAndClick(page, ['turn off microphone', 'turn off camera'], 2, 400)
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.keyboard.down(mod)
  await page.keyboard.press('KeyD').catch(() => undefined)
  await page.keyboard.press('KeyE').catch(() => undefined)
  await page.keyboard.up(mod)
}

async function askToJoin(page: Page) {
  const ok = await waitAndClick(
    page,
    ['ask to join', 'request to join', 'join now', 'join meeting', 'join'],
    20,
    1000,
  )
  if (!ok) {
    throw new Error('Could not find Ask to join / Join button')
  }
}

async function dumpDebug(page: Page, label: string) {
  const dir = path.join('/tmp', 'meet-bot-debug')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = Date.now()
  const shot = path.join(dir, `${label}-${stamp}.png`)
  const textFile = path.join(dir, `${label}-${stamp}.txt`)
  try {
    await page.screenshot({ path: shot, fullPage: true })
  } catch {
    // ignore
  }
  const body = await page.evaluate(() => document.body?.innerText || '')
  fs.writeFileSync(textFile, `URL: ${page.url()}\n\n${body}`)
  console.error(`[meet] debug dump: ${shot}`)
  console.error(`[meet] debug text: ${textFile}`)
  console.error(`[meet] page text preview:\n${body.slice(0, 800)}`)
}

async function isWaitingForHost(page: Page) {
  const body = ((await page.evaluate(() => document.body?.innerText || '')) || '')
    .toLowerCase()
  return (
    body.includes('asking to join') ||
    body.includes('asking to be let in') ||
    body.includes('waiting for the host') ||
    body.includes('you will join the call when someone lets you in') ||
    body.includes('someone will let you in soon')
  )
}

async function isInMeeting(page: Page) {
  const body = ((await page.evaluate(() => document.body?.innerText || '')) || '')
    .toLowerCase()
  const hasLeave =
    body.includes('leave call') ||
    (await page.$('[aria-label*="Leave call" i]')) !== null
  const stillLobby = await isWaitingForHost(page)
  return hasLeave && !stillLobby
}

export class MeetGuestSession {
  private browser: Browser | null = null
  private page: Page | null = null

  async start(payload: JoinPayload) {
    const headed = shouldRunHeaded()
    console.log(
      `[meet] launching chrome headed=${headed} path=${CHROME_PATH}`,
    )

    this.browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: headed ? false : true,
      // Hide the "Chrome is being controlled by automated test software" banner.
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=1280,720',
        ...(process.env.BOT_USER_DATA_DIR
          ? [`--user-data-dir=${process.env.BOT_USER_DATA_DIR}`]
          : []),
      ],
      defaultViewport: headed ? null : { width: 1280, height: 720 },
    })

    this.page = await this.browser.newPage()
    this.page.setDefaultTimeout(30_000)
    await this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    })

    try {
      console.log(`[meet] goto ${payload.meetLink}`)
      await this.page.goto(payload.meetLink, {
        waitUntil: 'domcontentloaded',
        timeout: 120_000,
      })
      await sleep(3000)

      const blocked = await this.page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase()
        return (
          text.includes("you can't join this video call") ||
          text.includes('you cant join this video call') ||
          text.includes("can't join this call")
        )
      })
      if (blocked) {
        await dumpDebug(this.page, 'blocked')
        throw new Error(
          "Meet blocked this browser (\"You can't join this video call\"). " +
            'Usually: (1) meeting host settings block guests, (2) Google detected automation, ' +
            'or (3) guest join requires a signed-in Google account. ' +
            'Try host settings → allow anyone with the link to ask to join, ' +
            'or use BOT_USER_DATA_DIR with a Chrome profile already logged into Google.',
        )
      }

      await dismissNoise(this.page)
      await sleep(1000)
      await dismissNoise(this.page)

      const named = await fillGuestName(this.page, payload.displayName)
      if (!named) {
        console.warn('[meet] could not fill guest name — continuing anyway')
      }

      await turnOffMedia(this.page)
      await askToJoin(this.page)
      console.log('[meet] join clicked — waiting for admission')
    } catch (error) {
      if (this.page) await dumpDebug(this.page, 'join-failed')
      throw error
    }
  }

  async waitForAdmission(timeoutMs: number): Promise<'waiting' | 'joined'> {
    if (!this.page) throw new Error('Session not started')

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await isInMeeting(this.page)) return 'joined'
      if (await isWaitingForHost(this.page)) {
        console.log('[meet] waiting for host to admit…')
      }
      await sleep(2000)
    }

    if (await isInMeeting(this.page)) return 'joined'
    await dumpDebug(this.page, 'admission-timeout')
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
      await sleep(5000)
    }
  }

  async leave() {
    if (!this.page) return
    await waitAndClick(this.page, ['leave call', 'leave meeting', 'leave'], 5, 500)
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
