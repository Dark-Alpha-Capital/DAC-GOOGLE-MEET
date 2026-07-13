import http from 'node:http'

import { MeetGuestSession } from './meet-session.js'
import { AudioRecorder } from './recorder.js'
import type { BotStatus, JoinPayload } from './types.js'

const PORT = Number(process.env.PORT || 8080)

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

async function reportStatus(
  payload: JoinPayload,
  next: string,
  errorMessage?: string,
) {
  try {
    await fetch(`${payload.callbackBaseUrl}/api/bot/status`, {
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
  } catch (error) {
    console.error('Failed to report status', error)
  }
}

async function runBot(payload: JoinPayload) {
  if (running) {
    throw new Error('Bot already running')
  }

  running = true
  stopRequested = false
  activePayload = payload
  status = {
    state: 'joining',
    meetingId: payload.meetingId,
    botRunId: payload.botRunId,
    errorMessage: null,
    startedAt: Date.now(),
  }

  session = new MeetGuestSession()
  recorder = new AudioRecorder(payload.botRunId)

  try {
    await session.start(payload)
    status.state = 'waiting_admission'
    await reportStatus(payload, 'waiting_admission')

    const admissionTimeout = Math.max(
      payload.endsAtMs - Date.now(),
      10 * 60 * 1000,
    )
    const admission = await session.waitForAdmission(admissionTimeout)
    if (admission !== 'joined' || stopRequested) {
      throw new Error('Not admitted before timeout or stop requested')
    }

    status.state = 'joined'
    await reportStatus(payload, 'joined')

    recorder.start()
    status.state = 'recording'

    await session.waitUntilMeetingEnds(payload.endsAtMs)

    status.state = 'leaving'
    await session.leave()
    await recorder.stop()
    await recorder.upload(payload, 'left')
    status.state = 'done'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    status.state = 'failed'
    status.errorMessage = message
    await reportStatus(payload, 'failed', message)

    try {
      await recorder?.stop()
      await recorder?.upload(payload, 'failed', message)
    } catch (uploadError) {
      console.error('Failed to upload failure recording', uploadError)
      // Still try to unblock the workflow with an empty complete call.
      try {
        const form = new FormData()
        form.set('botRunId', payload.botRunId)
        form.set('meetingId', payload.meetingId)
        form.set('workflowInstanceId', payload.workflowInstanceId)
        form.set('status', 'failed')
        form.set('errorMessage', message)
        await fetch(`${payload.callbackBaseUrl}/api/bot/complete`, {
          method: 'POST',
          headers: { 'x-bot-secret': payload.callbackSecret },
          body: form,
        })
      } catch {
        // ignore
      }
    }
  } finally {
    await session?.close()
    session = null
    recorder = null
    running = false
  }
}

async function handleJoin(req: http.IncomingMessage, res: http.ServerResponse) {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as JoinPayload

  if (!payload.meetLink || !payload.botRunId || !payload.callbackBaseUrl) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid join payload' }))
    return
  }

  void runBot(payload)
  res.writeHead(202, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ accepted: true }))
}

async function handleStop(_req: http.IncomingMessage, res: http.ServerResponse) {
  stopRequested = true
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
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ stopped: true, meetingId: activePayload?.meetingId }))
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, state: status.state }))
      return
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(status))
      return
    }

    if (req.method === 'POST' && url.pathname === '/join') {
      await handleJoin(req, res)
      return
    }

    if (req.method === 'POST' && url.pathname === '/stop') {
      await handleStop(req, res)
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  } catch (error) {
    console.error(error)
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }
})

server.listen(PORT, () => {
  console.log(`meet-bot listening on :${PORT}`)
})
