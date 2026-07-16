import { MeetGuestSession } from './src/meet-session.ts'
import { AudioRecorder } from './src/recorder.ts'
import type { BotStatus, JoinPayload } from './src/types.ts'

const PORT = Number(process.env.PORT || 8080)
const BOT_SECRET = process.env.BOT_INTERNAL_SECRET || ''

function log(...args: unknown[]) {
  console.log(`[meet-bot ${new Date().toISOString()}]`, ...args)
}

function logError(...args: unknown[]) {
  console.error(`[meet-bot ${new Date().toISOString()}]`, ...args)
}

function assertBotAuth(req: Request): Response | null {
  if (!BOT_SECRET) return null
  const secret = req.headers.get('x-bot-secret')
  if (secret === BOT_SECRET) return null
  return Response.json({ error: 'Unauthorized' }, { status: 401 })
}

let status: BotStatus = {
  state: 'idle',
  meetingId: null,
  botRunId: null,
  errorMessage: null,
  startedAt: null,
}

let activePayload: JoinPayload | null = null
let session: MeetGuestSession | null = null
let recorder: AudioRecorder | null = null
let running = false
let stopRequested = false
/** True while leave → stop recorder → upload is in progress (ignore destructive /stop). */
let finalizing = false

async function reportStatus(
  payload: JoinPayload,
  next: string,
  errorMessage?: string,
) {
  const url = `${payload.callbackBaseUrl}/api/bot/status`
  log(`callback status → ${next}`, url)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bot-secret': payload.callbackSecret,
      },
      body: JSON.stringify({
        botRunId: payload.botRunId,
        status: next,
        errorMessage,
      }),
    })
    const text = await res.text()
    log(`callback status response ${res.status}`, text.slice(0, 200))
  } catch (error) {
    logError('Failed to report status (callback unreachable?)', error)
  }
}

async function finishAndUpload(
  payload: JoinPayload,
  outcome: 'left' | 'failed',
  errorMessage?: string,
) {
  finalizing = true
  try {
    try {
      await session?.leave()
    } catch {
      // ignore
    }
    await recorder?.stop()
    if (outcome === 'left') {
      const hadAudio = await recorder?.hasAudioFile()
      if (!hadAudio) {
        throw new Error(
          'Meeting ended but recording file is missing or empty — refusing success',
        )
      }
    }
    await recorder?.upload(payload, outcome, errorMessage)
  } finally {
    finalizing = false
  }
}

async function runBot(payload: JoinPayload) {
  if (running) throw new Error('Bot already running')

  running = true
  stopRequested = false
  finalizing = false
  activePayload = payload
  status = {
    state: 'joining',
    meetingId: payload.meetingId,
    botRunId: payload.botRunId,
    errorMessage: null,
    startedAt: Date.now(),
  }

  log('runBot start', {
    meetingId: payload.meetingId,
    botRunId: payload.botRunId,
    meetLink: payload.meetLink,
    displayName: payload.displayName,
    callbackBaseUrl: payload.callbackBaseUrl,
    endsAt: new Date(payload.endsAtMs).toISOString(),
    chrome: process.env.PUPPETEER_EXECUTABLE_PATH,
    headed: process.env.BOT_HEADED,
    display: process.env.DISPLAY,
  })

  session = new MeetGuestSession()
  recorder = new AudioRecorder(payload.botRunId)

  try {
    log('launching chromium / opening Meet…')
    await session.start(payload)
    status.state = 'waiting_admission'
    log('Ask-to-join sent — waiting for host admission')
    await reportStatus(payload, 'waiting_admission')

    const admissionTimeout = Math.max(
      payload.endsAtMs - Date.now(),
      10 * 60 * 1000,
    )
    log(`admission timeout ${Math.round(admissionTimeout / 1000)}s`)
    const admission = await session.waitForAdmission(admissionTimeout)
    log(`admission result: ${admission} stopRequested=${stopRequested}`)
    if (admission !== 'joined' || stopRequested) {
      throw new Error('Not admitted before timeout or stop requested')
    }

    status.state = 'joined'
    log('admitted — starting recorder')
    await reportStatus(payload, 'joined')

    await recorder.start(session.getPage())
    status.state = 'recording'

    const leaveReason = await session.waitUntilMeetingEnds(
      payload.endsAtMs,
      () => stopRequested,
    )
    log(`meeting end detected reason=${leaveReason}`)

    status.state = 'leaving'
    log('leaving meeting / uploading recording')
    await finishAndUpload(payload, 'left')
    status.state = 'done'
    log('runBot done')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack : undefined
    status.state = 'failed'
    status.errorMessage = message
    logError('runBot FAILED:', message)
    if (stack) logError(stack)
    await reportStatus(payload, 'failed', message)

    try {
      await finishAndUpload(payload, 'failed', message)
    } catch (uploadError) {
      logError('Failed to upload failure recording', uploadError)
      try {
        const form = new FormData()
        form.set('botRunId', payload.botRunId)
        form.set('meetingId', payload.meetingId)
        form.set('workflowInstanceId', payload.workflowInstanceId)
        form.set('status', 'failed')
        form.set('errorMessage', message)
        const res = await fetch(`${payload.callbackBaseUrl}/api/bot/complete`, {
          method: 'POST',
          headers: { 'x-bot-secret': payload.callbackSecret },
          body: form,
        })
        log(`fallback complete callback ${res.status}`)
      } catch (completeError) {
        logError('fallback complete callback failed', completeError)
      }
    }
  } finally {
    await session?.close()
    session = null
    recorder = null
    running = false
    finalizing = false
    log('runBot cleanup finished, state=', status.state)
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    log(`${req.method} ${url.pathname}`)

    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, state: status.state })
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      return Response.json(status)
    }

    if (req.method === 'POST' && url.pathname === '/join') {
      const unauthorized = assertBotAuth(req)
      if (unauthorized) return unauthorized

      const payload = (await req.json()) as JoinPayload
      if (!payload.meetLink || !payload.botRunId || !payload.callbackBaseUrl) {
        logError('invalid join payload', payload)
        return Response.json({ error: 'Invalid join payload' }, { status: 400 })
      }
      if (running || finalizing) {
        log('join while busy — requesting stop of previous session')
        stopRequested = true
        const deadline = Date.now() + 60_000
        while ((running || finalizing) && Date.now() < deadline) {
          await Bun.sleep(500)
        }
        if (running || finalizing) {
          return Response.json(
            { error: 'Previous bot session still running' },
            { status: 409 },
          )
        }
      }
      void runBot(payload).catch((error) => {
        logError('unhandled runBot rejection', error)
      })
      return Response.json({ accepted: true }, { status: 202 })
    }

    if (req.method === 'POST' && url.pathname === '/stop') {
      const unauthorized = assertBotAuth(req)
      if (unauthorized) return unauthorized

      log('stop requested')
      stopRequested = true

      // While finalizing upload, do not tear down the browser mid-flight.
      if (finalizing || status.state === 'leaving' || status.state === 'recording') {
        log('stop: signaling runBot to leave; waiting for upload (no force-close)')
        return Response.json({
          stopped: true,
          soft: true,
          meetingId: activePayload?.meetingId ?? null,
        })
      }

      try {
        await session?.leave()
      } catch {
        // ignore
      }
      try {
        await session?.close()
      } catch {
        // ignore
      }
      return Response.json({
        stopped: true,
        meetingId: activePayload?.meetingId ?? null,
      })
    }

    return Response.json({ error: 'Not found' }, { status: 404 })
  },
})

log(`listening on :${server.port}`)
