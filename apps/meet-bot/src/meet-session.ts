import fs from 'node:fs'
import path from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'

import type { JoinPayload } from './types.ts'

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

/** Prefer headed (Xvfb in Docker) — Meet often blocks pure headless. */
function shouldRunHeaded() {
  if (process.env.BOT_HEADED === '1') return true
  if (process.env.BOT_HEADED === '0') return false
  if (process.env.DISPLAY) return true
  return process.platform === 'darwin' && !fs.existsSync('/.dockerenv')
}

function log(...args: unknown[]) {
  console.log(`[meet ${new Date().toISOString()}]`, ...args)
}

async function clickByText(page: Page, texts: string[]) {
  const lowered = texts.map((t) => t.toLowerCase())
  return page.evaluate((needles) => {
    const selector =
      'button, div[role="button"], span[role="button"], a[role="button"], [aria-label]'
    const nodes = Array.from(document.querySelectorAll(selector))

    type Cand = { el: HTMLElement; label: string; exact: boolean; score: number }
    const candidates: Cand[] = []

    for (const node of nodes) {
      const el = node as HTMLElement
      const aria = (el.getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
      const label = aria || text
      if (!label || label.length > 120) continue

      for (let i = 0; i < needles.length; i++) {
        const needle = needles[i]!
        const exact = label === needle
        const fuzzy = !exact && label.includes(needle)
        if (!exact && !fuzzy) continue
        // Prefer exact, earlier needles, shorter labels
        const score = (exact ? 0 : 1000) + i * 10 + label.length
        candidates.push({ el, label, exact, score })
      }
    }

    candidates.sort((a, b) => a.score - b.score)
    const best = candidates[0]
    if (!best) return null
    best.el.click()
    return best.label
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
      log(`clicked: "${clicked}"`)
      return true
    }
    await Bun.sleep(delayMs)
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
      const handle =
        (await page.$('input[aria-label*="name" i]')) ||
        (await page.$('input[placeholder*="name" i]')) ||
        (await page.$('input[type="text"]'))
      if (handle) {
        await handle.click({ clickCount: 3 })
        await handle.type(displayName, { delay: 15 })
      }
      log(`filled guest name: ${displayName}`)
      return true
    }
    await Bun.sleep(800)
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

/** Meet shows this before Ask to join when mic/cam permission is denied or skipped. */
async function continueWithoutMedia(page: Page) {
  const ok = await waitAndClick(
    page,
    [
      'continue without microphone and camera',
      'continue without mic and camera',
      'continue without microphone',
      'continue without camera',
    ],
    3,
    500,
  )
  if (ok) log('dismissed mic/camera prompt')
  return ok
}

/** Prefer a dedicated Ask/Join click — Meet often puts the label on nested spans. */
async function clickAskToJoinButton(page: Page): Promise<string | null> {
  const viaDom = await page.evaluate(() => {
    const needles = [
      'ask to join',
      'request to join',
      'join now',
      'join meeting',
    ]
    const nodes = Array.from(
      document.querySelectorAll(
        'button, div[role="button"], span[role="button"], a[role="button"]',
      ),
    )
    const scored: Array<{ el: HTMLElement; label: string; score: number }> = []
    for (const node of nodes) {
      const el = node as HTMLElement
      const aria = (el.getAttribute('aria-label') || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase()
      for (let i = 0; i < needles.length; i++) {
        const needle = needles[i]!
        if (aria === needle || text === needle) {
          scored.push({ el, label: aria || text, score: i })
        } else if (aria.includes(needle) || text === needle) {
          scored.push({ el, label: aria || text, score: 100 + i })
        } else if (text.includes(needle) && text.length < 40) {
          scored.push({ el, label: text, score: 200 + i })
        }
      }
    }
    scored.sort((a, b) => a.score - b.score)
    const best = scored[0]
    if (!best) return null
    best.el.scrollIntoView({ block: 'center', inline: 'center' })
    best.el.click()
    return best.label
  })
  if (viaDom) return viaDom

  // Puppeteer click by exact visible label (handles some Material buttons)
  for (const name of [
    'Ask to join',
    'Request to join',
    'Join now',
    'Join meeting',
  ]) {
    const found = await page.evaluate((n) => {
      const match = Array.from(
        document.querySelectorAll(
          'button, div[role="button"], span[role="button"]',
        ),
      ).find((node) => {
        const el = node as HTMLElement
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim()
        const a = (el.getAttribute('aria-label') || '').trim()
        return t === n || a === n
      }) as HTMLElement | undefined
      if (!match) return null
      const rect = match.getBoundingClientRect()
      match.scrollIntoView({ block: 'center', inline: 'center' })
      match.click()
      return {
        label: n.toLowerCase(),
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      }
    }, name)
    if (found) {
      try {
        await page.mouse.click(found.x, found.y)
      } catch {
        // DOM click already attempted
      }
      return found.label
    }
  }
  return null
}

async function askToJoin(page: Page) {
  for (let i = 0; i < 30; i++) {
    // Lobby or live call — stop trying to click Ask
    if (await isWaitingForHost(page)) {
      log('in lobby — Ask to join already submitted')
      return
    }
    if (await isInMeeting(page)) {
      log('already in live meeting')
      return
    }

    await continueWithoutMedia(page)

    const clicked = await clickAskToJoinButton(page)
    if (clicked) {
      log(`clicked Ask/Join: "${clicked}"`)
      await Bun.sleep(1200)
      await continueWithoutMedia(page)
      if (
        (await isWaitingForHost(page)) ||
        (await isInMeeting(page)) ||
        !(await isPreJoin(page))
      ) {
        return
      }
    } else {
      log(`Ask to join not found yet (attempt ${i + 1}/30)`)
    }
    await Bun.sleep(1000)
  }

  if ((await isInMeeting(page)) || (await isWaitingForHost(page))) {
    log('in meeting/lobby after retries — continuing')
    return
  }
  throw new Error('Could not find Ask to join / Join button')
}

async function dumpDebug(page: Page, label: string) {
  if (page.isClosed()) {
    console.error(`[meet] debug dump skipped — page closed (${label})`)
    return
  }
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
  let body = ''
  try {
    body = await page.evaluate(() => document.body?.innerText || '')
  } catch (error) {
    body = `(could not read body: ${error instanceof Error ? error.message : String(error)})`
  }
  try {
    fs.writeFileSync(textFile, `URL: ${page.url()}\n\n${body}`)
  } catch {
    // ignore
  }
  console.error(`[meet] debug dump: ${shot}`)
  console.error(`[meet] debug text: ${textFile}`)
  console.error(`[meet] page text preview:\n${body.slice(0, 800)}`)
}

async function pageBody(page: Page) {
  return ((await page.evaluate(() => document.body?.innerText || '')) || '')
    .toLowerCase()
}

async function isBlockedFromMeeting(page: Page) {
  const body = await pageBody(page)
  return (
    body.includes("you can't join this video call") ||
    body.includes('you cant join this video call') ||
    body.includes("can't join this call") ||
    body.includes('no one can join a meeting unless invited or admitted')
  )
}

async function isPreJoin(page: Page) {
  const body = await pageBody(page)
  return (
    body.includes('ready to join') ||
    body.includes('ask to join') ||
    body.includes('join now') ||
    body.includes('other ways to join')
  )
}

async function isWaitingForHost(page: Page) {
  const body = await pageBody(page)
  return (
    body.includes('asking to join') ||
    body.includes('asking to be let in') ||
    body.includes('waiting for the host') ||
    body.includes('you will join the call when someone lets you in') ||
    body.includes('someone will let you in soon') ||
    body.includes('please wait until a meeting host brings you into') ||
    body.includes('wait until a meeting host brings you') ||
    body.includes('you’ll join when someone lets you in') ||
    body.includes("you'll join when someone lets you in")
  )
}

/**
 * Live call only — lobby also shows "Leave call", so require no lobby/prejoin copy.
 */
async function isInMeeting(page: Page) {
  if (await isWaitingForHost(page)) return false
  if (await isPreJoin(page)) return false

  const body = (
    (await page.evaluate(() => document.body?.innerText || '')) || ''
  ).toLowerCase()
  const hasLeave =
    body.includes('leave call') ||
    (await page.$('[aria-label*="Leave call" i]')) !== null
  return hasLeave
}

async function meetingEndedUi(page: Page) {
  const body = await pageBody(page)
  return (
    body.includes('you left the meeting') ||
    body.includes('return to home screen') ||
    body.includes("you've been removed") ||
    body.includes('the call ended') ||
    body.includes('this meeting has ended') ||
    body.includes('rejoin')
  )
}

async function isAloneInMeeting(page: Page) {
  const body = await pageBody(page)
  return (
    body.includes("you're the only one here") ||
    body.includes('you are the only one here') ||
    body.includes('no one else is in the meeting') ||
    body.includes('waiting for others to join') ||
    body.includes('you are the only one in this call')
  )
}

export class MeetGuestSession {
  private browser: Browser | null = null
  private page: Page | null = null
  /** When true, we attached to a user-started Chrome — do not quit it on close(). */
  private attachedOnly = false

  async start(payload: JoinPayload) {
    const cdpUrl = (process.env.BOT_CDP_URL || '').replace(/\/$/, '')

    if (cdpUrl) {
      log('attaching to Chrome via CDP ' + cdpUrl)
      try {
        this.browser = await puppeteer.connect({
          browserURL: cdpUrl,
          defaultViewport: null,
        })
        this.attachedOnly = true
      } catch (error) {
        log('puppeteer.connect FAILED — is Chrome running with --remote-debugging-port?', error)
        throw error
      }
      log('attached to existing Chrome (no Puppeteer automation flags)')
    } else {
      const headed = shouldRunHeaded()
      const signedInDir =
        process.env.USE_CHROME_PROFILE === '1'
          ? process.env.BOT_USER_DATA_DIR
          : undefined
      const userDataDir =
        signedInDir || path.join('/tmp', 'meet-bot-guest-' + payload.botRunId)

      if (!signedInDir) {
        fs.mkdirSync(userDataDir, { recursive: true })
      }

      log(
        'launching chrome headed=' +
          headed +
          ' path=' +
          CHROME_PATH +
          ' guest=' +
          !signedInDir +
          ' userDataDir=' +
          userDataDir,
      )

      try {
        this.browser = await puppeteer.launch({
          executablePath: CHROME_PATH,
          headless: !headed,
          ignoreDefaultArgs: ['--enable-automation'],
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            '--window-size=1280,720',
            '--user-data-dir=' + userDataDir,
            ...(signedInDir
              ? [
                  '--profile-directory=' +
                    (process.env.BOT_PROFILE_DIRECTORY || 'Default'),
                ]
              : []),
          ],
          defaultViewport: { width: 1280, height: 720 },
        })
      } catch (error) {
        log('puppeteer.launch FAILED', error)
        throw error
      }
    }

    this.page = await this.browser.newPage()
    this.page.setDefaultTimeout(30_000)
    this.page.on('console', (msg) => {
      log('page.console[' + msg.type() + '] ' + msg.text())
    })
    this.page.on('pageerror', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      log('pageerror', message)
    })

    // Avoid Chrome mic/cam permission bubbles blocking Ask to join (CDP / headed)
    try {
      const origin = 'https://meet.google.com'
      const ctx = this.browser.defaultBrowserContext()
      await ctx.clearPermissionOverrides()
      await ctx.overridePermissions(origin, [])
    } catch (error) {
      log('permission override skipped', error)
    }

    // Confirm who we are before joining Meet
    try {
      await this.page.goto('https://myaccount.google.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      })
      await Bun.sleep(1500)
      const accountPreview = await this.page.evaluate(
        () => (document.body?.innerText || '').slice(0, 400),
      )
      log('Google account page preview:\n' + accountPreview)
      if (
        accountPreview.toLowerCase().includes('sign in') &&
        !accountPreview.toLowerCase().includes('@')
      ) {
        throw new Error(
          'Chrome profile is NOT signed in to Google. Run: bun run chrome:roghan then sign in, leave that Chrome open, then bun run dev:roghan',
        )
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('NOT signed in')) {
        throw error
      }
      log('could not verify Google account (continuing)', error)
    }

    try {
      log('goto ' + payload.meetLink)
      const nav = await this.page.goto(payload.meetLink, {
        waitUntil: 'domcontentloaded',
        timeout: 120_000,
      })
      // Meet often does a client-side redirect that detaches the first frame
      if (!nav || this.page.isClosed()) {
        throw new Error('Meet navigation failed or page closed')
      }
      await Bun.sleep(3000)
      try {
        await this.page.waitForFunction(
          () => document.readyState === 'complete' || document.body?.innerText,
          { timeout: 15_000 },
        )
      } catch {
        // continue — we'll read what we can
      }

      let url = ''
      let title = ''
      let preview = ''
      try {
        url = this.page.url()
        title = await this.page.title()
        preview = await this.page.evaluate(
          () => (document.body?.innerText || '').slice(0, 500),
        )
      } catch (error) {
        log('page read after goto failed (retrying once)', error)
        await Bun.sleep(2000)
        url = this.page.url()
        title = await this.page.title().catch(() => '')
        preview = await this.page
          .evaluate(() => (document.body?.innerText || '').slice(0, 500))
          .catch(() => '')
      }
      log('landed url=' + url + ' title=' + title)
      log('page text preview:\n' + preview)

      const blocked = await isBlockedFromMeeting(this.page)
      if (blocked) {
        await dumpDebug(this.page, 'blocked')
        throw new Error(
          'Meet blocked this browser ("You can\'t join this video call"). ' +
            'Invite roghankundra@gmail.com to the calendar event, set Meet access to Open or allow ask-to-join, ' +
            'and use CDP mode (bun run chrome:roghan + bun run dev:roghan).',
        )
      }

      await dismissNoise(this.page)
      await Bun.sleep(1000)
      await dismissNoise(this.page)

      // Signed-in users often see "Join now" not guest name field
      const named = await fillGuestName(this.page, payload.displayName)
      if (named) {
        log('guest name filled: ' + payload.displayName)
      } else {
        log('no guest name field (likely already signed in) — continuing')
      }

      await continueWithoutMedia(this.page)
      await turnOffMedia(this.page)
      await continueWithoutMedia(this.page)

      if (await isWaitingForHost(this.page)) {
        log('already in lobby — join request already pending')
      } else if (await isInMeeting(this.page)) {
        log('already in live meeting — join done')
      } else {
        // Always click Ask to join when still on the pre-join screen.
        // Do NOT treat lobby "Leave call" as already joined (common Meet UI).
        log('attempting Ask to join…')
        await askToJoin(this.page)
        await Bun.sleep(1500)
        await continueWithoutMedia(this.page)
      }

      if (await isBlockedFromMeeting(this.page)) {
        await dumpDebug(this.page, 'blocked-after-join')
        throw new Error(
          'Meet rejected join after Ask/Join now. Invite the bot Gmail to the meeting.',
        )
      }
      if (await isWaitingForHost(this.page)) {
        log('in lobby — waiting for host to admit')
      } else if (await isInMeeting(this.page)) {
        log('in live meeting — join complete')
      } else if (await isPreJoin(this.page)) {
        await dumpDebug(this.page, 'still-prejoin')
        throw new Error(
          'Still on pre-join screen after Ask to join — button click may have failed',
        )
      }
      const afterJoin = await this.page.evaluate(
        () => (document.body?.innerText || '').slice(0, 400),
      )
      log('Ask/Join flow done — page text:\n' + afterJoin)
    } catch (error) {
      log('join flow FAILED', error)
      if (this.page) await dumpDebug(this.page, 'join-failed')
      throw error
    }
  }

  async waitForAdmission(timeoutMs: number): Promise<'waiting' | 'joined'> {
    if (!this.page) throw new Error('Session not started')

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await isBlockedFromMeeting(this.page)) {
        await dumpDebug(this.page, 'blocked-while-waiting')
        throw new Error(
          "Meet blocked join while waiting (\"You can't join this video call\").",
        )
      }
      if (await isInMeeting(this.page)) return 'joined'
      if (await isWaitingForHost(this.page)) {
        log('waiting for host to admit…')
      } else {
        const snippet = await this.page.evaluate(
          () => (document.body?.innerText || '').slice(0, 200),
        )
        log(`still not in lobby/meeting yet — preview: ${snippet.replace(/\s+/g, ' ')}`)
      }
      await Bun.sleep(2000)
    }

    if (await isInMeeting(this.page)) return 'joined'
    await dumpDebug(this.page, 'admission-timeout')
    return 'waiting'
  }

  async waitUntilMeetingEnds(
    endsAtMs: number,
    shouldStop?: () => boolean,
  ) {
    if (!this.page) throw new Error('Session not started')

    const aloneLimitMs = 60_000
    let aloneSince: number | null = null

    while (Date.now() < endsAtMs + 60_000) {
      if (shouldStop?.()) {
        log('stop requested during meeting')
        return
      }
      if (await meetingEndedUi(this.page)) {
        log('meeting ended UI detected')
        return
      }

      const inCall = await isInMeeting(this.page)
      if (!inCall && !(await isWaitingForHost(this.page))) {
        log('no longer in call/lobby — treating as meeting end')
        return
      }

      if (inCall && (await isAloneInMeeting(this.page))) {
        if (aloneSince == null) aloneSince = Date.now()
        const aloneFor = Date.now() - aloneSince
        log(`alone in meeting for ${Math.round(aloneFor / 1000)}s`)
        if (aloneFor >= aloneLimitMs) {
          log('alone timeout — leaving')
          return
        }
      } else {
        aloneSince = null
      }

      if (Date.now() >= endsAtMs) {
        log('calendar end time reached — leaving')
        return
      }

      await Bun.sleep(5000)
    }
  }

  getPage() {
    return this.page
  }

  async leave() {
    if (!this.page) return
    await waitAndClick(this.page, ['leave call', 'leave meeting', 'leave'], 5, 500)
  }

  async close() {
    try {
      await this.page?.close()
    } catch {
      // ignore
    }
    this.page = null

    if (this.attachedOnly) {
      try {
        this.browser?.disconnect()
      } catch {
        // ignore
      }
      this.browser = null
      return
    }

    try {
      await this.browser?.close()
    } catch {
      // ignore
    }
    this.browser = null
  }
}
