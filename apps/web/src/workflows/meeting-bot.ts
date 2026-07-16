import { Container, getContainer } from '@cloudflare/containers'
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'

import * as schema from '#/db/schema'
import { botRun, meeting } from '#/db/schema'

export type MeetingBotParams = {
  meetingId: string
  meetLink: string
  startsAtMs: number
  endsAtMs: number
  displayName: string
}

export type RecordingDonePayload = {
  botRunId: string
  recordingKey: string | null
  status: 'left' | 'failed'
  errorMessage?: string
}

const FIVE_MIN_MS = 5 * 60 * 1000
const ADMISSION_BUFFER_MS = 15 * 60 * 1000

/** Container → host callbacks can't use localhost; rewrite for Docker Desktop. */
function resolveCallbackBaseUrl(raw: string, usingHostBot: boolean) {
  const base = raw.replace(/\/$/, '')
  // Host bot talks to vite on the same machine — keep localhost.
  if (usingHostBot) return base
  try {
    const url = new URL(base)
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      url.hostname = 'host.docker.internal'
      console.log(
        `[workflow] rewritten callback ${base} → ${url.toString().replace(/\/$/, '')}`,
      )
      return url.toString().replace(/\/$/, '')
    }
  } catch {
    // keep as-is
  }
  return base
}

type JoinBody = {
  meetingId: string
  meetLink: string
  displayName: string
  botRunId: string
  endsAtMs: number
  workflowInstanceId: string
  callbackBaseUrl: string
  callbackSecret: string
}

async function postBotJoin(
  env: Env & { MEET_BOT_URL?: string },
  body: JoinBody,
  meetingId: string,
): Promise<Response> {
  const hostUrl = (env.MEET_BOT_URL || '').replace(/\/$/, '')
  if (hostUrl) {
    console.log(`[workflow] using host bot ${hostUrl}/join (guest Chrome on machine)`)
    return fetch(`${hostUrl}/join`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bot-secret': body.callbackSecret,
      },
      body: JSON.stringify(body),
    })
  }

  const container = getContainer(
    env.MEET_BOT_CONTAINER as unknown as DurableObjectNamespace<Container>,
    meetingId,
  )
  console.log(`[workflow] starting container for meeting=${meetingId}`)
  await container.startAndWaitForPorts()
  return container.fetch(
    new Request('http://container/join', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bot-secret': body.callbackSecret,
      },
      body: JSON.stringify(body),
    }),
  )
}

async function postBotStop(
  env: Env & { MEET_BOT_URL?: string },
  meetingId: string,
) {
  const secret = env.BOT_INTERNAL_SECRET
  const headers: Record<string, string> = {}
  if (secret) headers['x-bot-secret'] = secret

  const hostUrl = (env.MEET_BOT_URL || '').replace(/\/$/, '')
  if (hostUrl) {
    await fetch(`${hostUrl}/stop`, { method: 'POST', headers })
    return
  }
  const container = getContainer(
    env.MEET_BOT_CONTAINER as unknown as DurableObjectNamespace<Container>,
    meetingId,
  )
  await container.fetch(
    new Request('http://container/stop', { method: 'POST', headers }),
  )
}

function db(env: Env) {
  return drizzle(env.DB, { schema })
}

export class MeetingBotWorkflow extends WorkflowEntrypoint<
  Env,
  MeetingBotParams
> {
  async run(event: WorkflowEvent<MeetingBotParams>, step: WorkflowStep) {
    const { meetingId, meetLink, startsAtMs, endsAtMs, displayName } =
      event.payload
    const instanceId = event.instanceId

    const prepared = await step.do('prepare', async () => {
      if (!meetLink.includes('meet.google.com')) {
        throw new Error(`Invalid Meet URL: ${meetLink}`)
      }

      const botRunId = crypto.randomUUID()
      const database = db(this.env)

      await database.insert(botRun).values({
        id: botRunId,
        meetingId,
        status: 'pending',
        workflowInstanceId: instanceId,
      })

      await database
        .update(meeting)
        .set({ workflowInstanceId: instanceId })
        .where(eq(meeting.id, meetingId))

      console.log(
        `[workflow] prepare done meeting=${meetingId} botRun=${botRunId} instance=${instanceId}`,
      )
      return { botRunId }
    })

    const wakeAt = Math.max(Date.now(), startsAtMs - FIVE_MIN_MS)
    console.log(
      `[workflow] sleeping until ${new Date(wakeAt).toISOString()} meeting=${meetingId} (T-5 / immediate if already due)`,
    )
    await step.sleepUntil('wake-t-minus-5', wakeAt)
    console.log(`[workflow] woke meeting=${meetingId} — launching container`)

    await step.do('launch', async () => {
      const database = db(this.env)
      await database
        .update(botRun)
        .set({ status: 'joining' })
        .where(eq(botRun.id, prepared.botRunId))

      const usingHostBot = Boolean(
        (this.env as Env & { MEET_BOT_URL?: string }).MEET_BOT_URL,
      )
      const callbackBaseUrl = resolveCallbackBaseUrl(
        this.env.BETTER_AUTH_URL,
        usingHostBot,
      )
      const joinBody: JoinBody = {
        meetingId,
        meetLink,
        displayName,
        botRunId: prepared.botRunId,
        endsAtMs,
        workflowInstanceId: instanceId,
        callbackBaseUrl,
        callbackSecret: this.env.BOT_INTERNAL_SECRET,
      }

      console.log(
        `[workflow] POST /join meeting=${meetingId} callback=${callbackBaseUrl}`,
      )
      const response = await postBotJoin(this.env, joinBody, meetingId)

      const responseText = await response.text()
      console.log(
        `[workflow] /join response ${response.status}: ${responseText.slice(0, 300)}`,
      )

      if (!response.ok) {
        await database
          .update(botRun)
          .set({
            status: 'failed',
            errorMessage: `Launch failed: ${responseText}`,
          })
          .where(eq(botRun.id, prepared.botRunId))
        throw new Error(
          `Bot launch failed (${response.status}): ${responseText}`,
        )
      }

      return { accepted: true }
    })

    const timeoutMs = Math.max(
      endsAtMs - Date.now() + ADMISSION_BUFFER_MS,
      ADMISSION_BUFFER_MS,
    )
    const timeoutMinutes = Math.max(Math.ceil(timeoutMs / 60_000), 15)

    let done: RecordingDonePayload
    try {
      const eventResult = await step.waitForEvent<RecordingDonePayload>(
        'recording-done',
        {
          type: 'recording-done',
          timeout: `${timeoutMinutes} minutes`,
        },
      )
      done = eventResult.payload
    } catch {
      done = {
        botRunId: prepared.botRunId,
        recordingKey: null,
        status: 'failed',
        errorMessage: 'Timed out waiting for bot recording-done event',
      }
    }

    await step.do('finalize', async () => {
      const database = db(this.env)
      const now = new Date()

      const existing = await database.query.botRun.findFirst({
        where: eq(botRun.id, prepared.botRunId),
      })

      // Do not overwrite a successful left with timeout-failed
      if (
        existing?.status === 'left' &&
        done.status === 'failed' &&
        done.errorMessage?.includes('Timed out')
      ) {
        console.log(
          `[workflow] finalize skip overwrite — bot_run already left meeting=${meetingId}`,
        )
      } else {
        await database
          .update(botRun)
          .set({
            status: done.status,
            recordingKey: done.recordingKey ?? existing?.recordingKey ?? null,
            errorMessage: done.errorMessage ?? null,
            leftAt: existing?.leftAt ?? now,
          })
          .where(eq(botRun.id, prepared.botRunId))
      }

      if (done.status === 'left' || existing?.status === 'left') {
        await database
          .update(meeting)
          .set({ status: 'completed' })
          .where(eq(meeting.id, meetingId))
      }

      try {
        await postBotStop(this.env, meetingId)
      } catch (error) {
        console.error('Failed to stop meet bot', error)
      }

      return { finalized: true }
    })
  }
}
