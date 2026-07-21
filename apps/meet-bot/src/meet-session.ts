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

const CHROME_LOCK_FILES = [
  'SingletonLock',
  'SingletonCookie',
  'SingletonSocket',
  '.org.chromium.Chromium.lockfile',
] as const

/** Prefer headed (Xvfb in Docker) — Meet often blocks pure headless. */
function shouldRunHeaded() {
  if (process.env.BOT_HEADED === '1') return true
  if (process.env.BOT_HEADED === '0') return false
  if (process.env.DISPLAY) return true
  return process.platform === 'darwin' && !fs.existsSync('/.dockerenv')
}

/**
 * Copy baked profile to /tmp and drop Singleton* locks.
 * Image layers may be read-only or retain bootstrap locks (host/pid from build).
 */
function materializeChromeProfile(sourceDir: string, botRunId: string): string {
  const dest = path.join('/tmp', `chrome-profile-${botRunId}`)
  fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(sourceDir, dest, { recursive: true })
  for (const name of CHROME_LOCK_FILES) {
    try {
      fs.unlinkSync(path.join(dest, name))
    } catch {
      // missing
    }
  }
  try {
    for (const ent of fs.readdirSync(dest)) {
      if (ent.startsWith('Singleton')) {
        try {
          fs.unlinkSync(path.join(dest, ent))
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  log(`materialized chrome profile ${sourceDir} → ${dest} (locks cleared)`)
  return dest
}

function log(...args: unknown[]) {
  console.log(`[meet ${new Date().toISOString()}]`, ...args)
}

function isDetachedFrameError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('detached Frame') ||
    message.includes('Execution context was destroyed') ||
    message.includes('Cannot find context with specified id') ||
    message.includes('Target closed')
  )
}

async function clickByText(page: Page, texts: string[]) {
  if (page.isClosed()) return null
  const lowered = texts.map((t) => t.toLowerCase())
  try {
    return await page.evaluate((needles) => {
      const selector =
        'button, div[role="button"], span[role="button"], a[role="button"], [aria-label]'
      const nodes = Array.from(document.querySelectorAll(selector))

      type Cand = {
        el: HTMLElement
        label: string
        exact: boolean
        score: number
      }
      const candidates: Cand[] = []

      for (const node of nodes) {
        const el = node as HTMLElement
        const aria = (el.getAttribute('aria-label') || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
        const text = (el.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase()
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
  } catch (error) {
    if (isDetachedFrameError(error)) return null
    throw error
  }
}

async function waitAndClick(
  page: Page,
  texts: string[],
  attempts = 15,
  delayMs = 1000,
) {
  for (let i = 0; i < attempts; i++) {
    if (page.isClosed()) return false
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
        await handle.click({ count: 3 })
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
  if (page.isClosed()) return null
  let viaDom: string | null = null
  try {
    viaDom = await page.evaluate(() => {
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
  } catch (error) {
    if (isDetachedFrameError(error)) return null
    throw error
  }
  if (viaDom) return viaDom

  // Puppeteer click by exact visible label (handles some Material buttons)
  for (const name of [
    'Ask to join',
    'Request to join',
    'Join now',
    'Join meeting',
  ]) {
    let found: { label: string; x: number; y: number } | null = null
    try {
      found = await page.evaluate((n) => {
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
    } catch (error) {
      if (isDetachedFrameError(error)) return null
      throw error
    }
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
    if (page.isClosed()) {
      throw new Error('Meet page closed during Ask to join')
    }
    try {
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
    } catch (error) {
      // Meet often navigates right after Ask/Join and detaches the frame mid-evaluate.
      if (!isDetachedFrameError(error)) throw error
      log('Ask to join hit detached frame — waiting for navigation', error)
      await Bun.sleep(1500)
      continue
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
  // Do NOT match Meet's generic safety footer:
  // "No one can join a meeting unless invited or admitted by the host"
  // — that text also appears on the "removed / denied" screen.
  return (
    body.includes("you can't join this video call") ||
    body.includes('you cant join this video call') ||
    body.includes("can't join this call") ||
    body.includes("you can't join this call")
  )
}

/** Host denied ask-to-join or removed the bot from the lobby/call. */
async function isDeniedOrRemoved(page: Page) {
  const body = await pageBody(page)
  return (
    body.includes("you've been removed") ||
    body.includes('you have been removed') ||
    body.includes('you were removed') ||
    body.includes('denied entry') ||
    body.includes('entry denied') ||
    body.includes("couldn't join") ||
    body.includes('could not join') ||
    (body.includes('returning to home screen') &&
      !body.includes('leave call') &&
      !body.includes('ready to join'))
  )
}

async function isPreJoin(page: Page) {
  const body = await pageBody(page)
  // Exact pre-join screen — avoid matching in-call controls
  return (
    body.includes('ready to join?') ||
    body.includes('ready to join') && body.includes('other ways to join') ||
    (body.includes('ask to join') && body.includes('ready to join'))
  )
}

/** True only on the lobby / knocker screen (not when already in the call). */
async function isWaitingForHost(page: Page) {
  const body = await pageBody(page)
  // Never treat live-call UI as lobby. "Meeting host" in the People panel
  // previously false-triggered vague "waiting for the host" matches.
  if (await hasInCallToolbar(page)) return false

  return (
    body.includes('asking to join') ||
    body.includes('asking to be let in') ||
    body.includes('please wait until a meeting host brings you into the call') ||
    body.includes('please wait until a meeting host brings you into') ||
    body.includes('you will join the call when someone lets you in') ||
    body.includes('someone will let you in soon') ||
    body.includes("you'll join when someone lets you in") ||
    body.includes('you’ll join when someone lets you in')
  )
}

/** Controls that only appear after you are inside the Meet call. */
async function hasInCallToolbar(page: Page) {
  return page.evaluate(() => {
    const leave =
      document.querySelector('[aria-label*="Leave call" i]') !== null ||
      document.querySelector('[aria-label*="Leave meeting" i]') !== null
    if (!leave) {
      const body = (document.body?.innerText || '').toLowerCase()
      if (!body.includes('leave call')) return false
    }
    const captions =
      document.querySelector('[aria-label*="caption" i]') !== null ||
      document.querySelector('[aria-label*="Captions" i]') !== null
    const present =
      document.querySelector('[aria-label*="Present now" i]') !== null ||
      document.querySelector('[aria-label*="Share screen" i]') !== null
    const people =
      document.querySelector('[aria-label*="People" i]') !== null ||
      document.querySelector('[aria-label*="Show everyone" i]') !== null
    const raise =
      document.querySelector('[aria-label*="Raise hand" i]') !== null
    const body = (document.body?.innerText || '').toLowerCase()
    const bodySignals =
      body.includes('turn on captions') ||
      body.includes('raise hand') ||
      body.includes('present now') ||
      body.includes('share screen') ||
      body.includes('send a reaction') ||
      body.includes('meeting host') ||
      /contributors?\s*\d+/i.test(body)

    return Boolean(captions || present || people || raise || bodySignals)
  })
}

/**
 * Live call — lobby can also show Leave call, so require in-call toolbar signals.
 */
async function isInMeeting(page: Page) {
  if (await isPreJoin(page)) return false
  if (await isWaitingForHost(page)) return false
  return hasInCallToolbar(page)
}

async function meetingEndedUi(page: Page) {
  const body = await pageBody(page)
  return (
    body.includes('you left the meeting') ||
    body.includes("you've been removed") ||
    body.includes('the call ended') ||
    body.includes('this meeting has ended') ||
    (body.includes('return to home screen') && !body.includes('leave call')) ||
    (body.includes('rejoin') && !body.includes('leave call'))
  )
}

/**
 * Host left / bot alone. Prefer People-panel contributor count when available.
 */
async function isAloneInMeeting(page: Page) {
  return page.evaluate(() => {
    const body = (document.body?.innerText || '').toLowerCase()
    if (
      body.includes("you're the only one here") ||
      body.includes('you are the only one here') ||
      body.includes('no one else is in the meeting') ||
      body.includes('you are the only one in this call')
    ) {
      return true
    }

    const contrib = body.match(/contributors?\s*(\d+)/i)
    if (contrib) {
      const count = Number(contrib[1])
      if (count <= 1) return true
    }

    // Host label gone while still in call → treat as host left
    const hasMeetingHost = body.includes('meeting host')
    const someoneLeft =
      body.includes('has left the meeting') || body.includes('left the meeting')
    if (someoneLeft && !hasMeetingHost) return true

    return false
  })
}

/** Best-effort open People panel so contributor count / host label are readable. */
async function refreshPeoplePanel(page: Page) {
  await page.evaluate(() => {
    const btn = Array.from(
      document.querySelectorAll('button, div[role="button"]'),
    ).find((el) => {
      const a = (el.getAttribute('aria-label') || '').toLowerCase()
      return (
        a.includes('people') ||
        a.includes('show everyone') ||
        a === 'people'
      )
    }) as HTMLElement | undefined
    btn?.click()
  }).catch(() => undefined)
}

export type ObservedAttendee = {
  name: string
  email?: string | null
  firstSeenAt: number
  lastSeenAt: number
  leftDuringCall?: boolean
}

/**
 * Scrape visible participant names from Meet's People panel / tiles.
 * Emails are often unavailable in the guest UI — capture when present.
 */
async function scrapeAttendees(page: Page): Promise<Array<{ name: string; email?: string | null }>> {
  return page.evaluate(() => {
    const results: Array<{ name: string; email?: string | null }> = []
    const seen = new Set<string>()

    const push = (raw: string, email?: string | null) => {
      const name = raw.replace(/\s+/g, ' ').trim()
      if (!name || name.length < 2 || name.length > 80) return
      const lower = name.toLowerCase()
      if (
        lower === 'you' ||
        lower.includes('people') ||
        lower.includes('contributors') ||
        lower.includes('meeting host') ||
        lower.includes('ask to join') ||
        lower.includes('present now') ||
        lower.includes('share screen')
      ) {
        return
      }
      const key = `${lower}|${(email || '').toLowerCase()}`
      if (seen.has(key)) return
      seen.add(key)
      results.push({ name, email: email || null })
    }

    // People list rows often expose aria-label / data-participant-id text
    for (const el of Array.from(
      document.querySelectorAll(
        '[data-participant-id], [data-self-name], [aria-label*="@"], div[role="listitem"]',
      ),
    )) {
      const aria = (el.getAttribute('aria-label') || '').trim()
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
      const source = aria || text
      if (!source) continue
      const emailMatch = source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
      const namePart = source
        .split(/[·|•\n]/)[0]
        ?.replace(emailMatch?.[0] || '', '')
        .trim()
      if (namePart) push(namePart, emailMatch?.[0] || null)
    }

    // Video tile name overlays
    for (const el of Array.from(
      document.querySelectorAll('[data-self-name], span[class*="name"]'),
    )) {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
      if (text) push(text)
    }

    return results
  })
}

export class MeetGuestSession {
  private browser: Browser | null = null
  private page: Page | null = null
  /** When true, we attached to a user-started Chrome — do not quit it on close(). */
  private attachedOnly = false
  /** Cumulative attendees observed during the call (with first/last seen). */
  private attendees = new Map<string, ObservedAttendee>()
  /** People missing from the last scrape for this many ms are marked leftDuringCall. */
  private static readonly LEFT_GRACE_MS = 45_000

  private mergeAttendeeBatch(
    batch: Array<{ name: string; email?: string | null }>,
    now = Date.now(),
  ) {
    const seenKeys = new Set<string>()
    for (const person of batch) {
      const key = `${person.name.toLowerCase()}|${(person.email || '').toLowerCase()}`
      seenKeys.add(key)
      const existing = this.attendees.get(key)
      if (existing) {
        existing.lastSeenAt = now
        existing.leftDuringCall = false
        if (person.email && !existing.email) existing.email = person.email
      } else {
        this.attendees.set(key, {
          name: person.name,
          email: person.email || null,
          firstSeenAt: now,
          lastSeenAt: now,
          leftDuringCall: false,
        })
      }
    }
    for (const [key, person] of this.attendees) {
      if (seenKeys.has(key)) continue
      if (now - person.lastSeenAt >= MeetGuestSession.LEFT_GRACE_MS) {
        person.leftDuringCall = true
      }
    }
  }

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
      const bakedProfile =
        process.env.USE_CHROME_PROFILE === '1'
          ? process.env.BOT_USER_DATA_DIR
          : undefined
      const userDataDir = bakedProfile
        ? materializeChromeProfile(bakedProfile, payload.botRunId)
        : path.join('/tmp', 'meet-bot-guest-' + payload.botRunId)

      if (!bakedProfile) {
        fs.mkdirSync(userDataDir, { recursive: true })
      }

      log(
        'launching chrome headed=' +
          headed +
          ' path=' +
          CHROME_PATH +
          ' guest=' +
          !bakedProfile +
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
            // Must match bootstrap: cookies encrypted with peanuts / basic store.
            '--password-store=basic',
            '--window-size=1280,720',
            '--user-data-dir=' + userDataDir,
            ...(bakedProfile
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

    // Confirm who we are before joining Meet (signed-in profile required in containers).
    try {
      await this.page.goto('https://myaccount.google.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      })
      await Bun.sleep(1500)
      const accountUrl = this.page.url()
      const accountPreview = await this.page.evaluate(
        () => (document.body?.innerText || '').slice(0, 400),
      )
      log('Google account url=' + accountUrl)
      log('Google account page preview:\n' + accountPreview)

      // Cookie decrypt works ⇒ Chromium exposes SID. Marketing "about" pages also say "Sign in".
      const authCookies = await this.page.cookies(
        'https://www.google.com',
        'https://myaccount.google.com',
        'https://accounts.google.com',
        'https://meet.google.com',
      )
      const criticalNames = ['SID', '__Secure-1PSID', '__Secure-3PSID']
      const hasSid = authCookies.some((c) => criticalNames.includes(c.name))
      const visible = authCookies
        .filter((c) =>
          [...criticalNames, 'OSID', 'HSID', 'SSID'].includes(c.name),
        )
        .map((c) => `${c.name}@${c.domain}`)
        .join(',')
      log('auth cookies visible to Chromium: ' + (visible || 'none'))

      const lower = accountPreview.toLowerCase()
      const onMarketingAbout =
        accountUrl.includes('account/about') ||
        accountUrl.includes('/signin') ||
        accountUrl.includes('ServiceLogin')
      // Marketing landing copy (seen when SID decrypts but Google rejects session):
      // "Sign in to your Google Account" / "Go to Google Account" / "All of Google"
      const signedOutUi =
        onMarketingAbout ||
        lower.includes('go to google account') ||
        lower.includes('sign in to your google account') ||
        (lower.includes('all of google') && lower.includes('sign in')) ||
        (lower.includes('create an account') &&
          lower.includes('sign in') &&
          !lower.includes('@'))

      // SID present ≠ Google accepts the session. Cloned .co.in→.com cookies decrypt
      // but get 401 from Google APIs; Meet then shows guest "Sign in" + name field.
      if (!hasSid || signedOutUi) {
        throw new Error(
          'Chrome profile is not signed in to Google (session rejected). ' +
            'Do NOT rely on .co.in cookie cloning. Re-bootstrap on amd64: ' +
            'open https://www.google.com/ncr → sign in → myaccount.google.com must show your email ' +
            '(not account/about) → quit Chromium → deploy:containers.',
        )
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('not signed in to Google')
      ) {
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

      const previewLower = preview.toLowerCase()
      const meetShowsGuestSignIn =
        previewLower.includes('sign in') &&
        (previewLower.includes('getting ready') ||
          previewLower.includes("you'll be able to join") ||
          previewLower.includes('ask to join'))
      if (meetShowsGuestSignIn) {
        await dumpDebug(this.page, 'meet-guest-not-signed-in')
        throw new Error(
          'Meet is treating the bot as a guest (Sign in visible). ' +
            'Inviting the bot Gmail does nothing until Chromium is actually signed in. ' +
            'Re-bootstrap via https://www.google.com/ncr until myaccount shows the email.',
        )
      }

      const blocked = await isBlockedFromMeeting(this.page)
      if (blocked) {
        await dumpDebug(this.page, 'blocked')
        throw new Error(
          'Meet blocked this browser ("You can\'t join this video call"). ' +
            'Invite the bot Gmail to the calendar event, set Meet host controls to allow ask-to-join / open access, ' +
            'and ensure the container Chrome profile is signed in (see apps/meet-bot/scripts/bootstrap-linux-profile.md).',
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
      if (await isDeniedOrRemoved(this.page)) {
        await dumpDebug(this.page, 'denied-or-removed')
        throw new Error(
          'Host denied admission or removed the bot from the meeting. Admit "Roghan Kundra" / the bot when it asks to join.',
        )
      }
      if (await isBlockedFromMeeting(this.page)) {
        await dumpDebug(this.page, 'blocked-while-waiting')
        throw new Error(
          'Meet blocked this browser from joining. Invite the bot Gmail and retry.',
        )
      }
      if (await isInMeeting(this.page)) {
        log('in-call toolbar detected — admitted')
        return 'joined'
      }
      if (await isWaitingForHost(this.page)) {
        log('waiting for host to admit…')
      } else {
        const snippet = await this.page.evaluate(
          () => (document.body?.innerText || '').slice(0, 200),
        )
        log(
          `still not in lobby/meeting yet — preview: ${snippet.replace(/\s+/g, ' ')}`,
        )
      }
      await Bun.sleep(2000)
    }

    if (await isInMeeting(this.page)) return 'joined'
    await dumpDebug(this.page, 'admission-timeout')
    return 'waiting'
  }

  /**
   * Poll until the call should end. Prefer real end signals (UI / alone / stop).
   * Calendar end is a soft hint — overtime meetings keep running until hard max.
   */
  async waitUntilMeetingEnds(
    endsAtMs: number,
    shouldStop?: () => boolean,
  ): Promise<'alone' | 'calendar_end' | 'ended_ui' | 'stop' | 'dropped'> {
    if (!this.page) throw new Error('Session not started')

    const aloneLimitMs = 20_000
    // Allow overtime past calendar end; hard stop after +3h from calendar end
    // (or +4h from now if calendar already ended when we joined).
    const hardStopAt = Math.max(endsAtMs + 3 * 60 * 60 * 1000, Date.now() + 4 * 60 * 60 * 1000)
    let aloneSince: number | null = null
    let tick = 0
    let calendarEndLogged = false

    while (Date.now() < hardStopAt) {
      if (shouldStop?.()) {
        log('leave reason=stop')
        return 'stop'
      }
      if (await meetingEndedUi(this.page)) {
        log('leave reason=ended_ui')
        return 'ended_ui'
      }

      if (tick % 2 === 0) {
        await refreshPeoplePanel(this.page)
        await Bun.sleep(500)
        try {
          const batch = await scrapeAttendees(this.page)
          this.mergeAttendeeBatch(batch)
          log(`attendance scrape: ${batch.length} visible, ${this.attendees.size} unique total`)
        } catch {
          // ignore scrape failures
        }
      }
      tick += 1

      const inCall = await isInMeeting(this.page)
      if (!inCall && !(await isWaitingForHost(this.page))) {
        log('leave reason=dropped')
        return 'dropped'
      }

      // Alone / host-left only while clearly in the live call
      if (inCall && (await isAloneInMeeting(this.page))) {
        if (aloneSince == null) aloneSince = Date.now()
        const aloneFor = Date.now() - aloneSince
        log(
          `host gone / alone in meeting for ${Math.round(aloneFor / 1000)}s — will leave at ${aloneLimitMs / 1000}s`,
        )
        if (aloneFor >= aloneLimitMs) {
          log('leave reason=alone')
          return 'alone'
        }
      } else {
        aloneSince = null
      }

      if (Date.now() >= endsAtMs) {
        if (!calendarEndLogged) {
          log(
            'calendar end reached — staying until alone/ended_ui/stop/hard-max (overtime)',
          )
          calendarEndLogged = true
        }
      }

      await Bun.sleep(5000)
    }

    log('leave reason=calendar_end (hard max)')
    return 'calendar_end'
  }

  getPage() {
    return this.page
  }

  /** Final scrape + return all attendees seen during the call (with presence). */
  async collectAttendees(): Promise<
    Array<{
      name: string
      email?: string | null
      firstSeenAt: string
      lastSeenAt: string
      leftDuringCall: boolean
    }>
  > {
    if (this.page) {
      try {
        await refreshPeoplePanel(this.page)
        await Bun.sleep(400)
        const batch = await scrapeAttendees(this.page)
        this.mergeAttendeeBatch(batch)
      } catch {
        // ignore
      }
    }
    const list = Array.from(this.attendees.values()).map((person) => ({
      name: person.name,
      email: person.email ?? null,
      firstSeenAt: new Date(person.firstSeenAt).toISOString(),
      lastSeenAt: new Date(person.lastSeenAt).toISOString(),
      leftDuringCall: Boolean(person.leftDuringCall),
    }))
    log(`collected ${list.length} attendees`)
    return list
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
