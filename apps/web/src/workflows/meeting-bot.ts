import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'

import * as schema from '#/db/schema'
import { botRun, meeting } from '#/db/schema'
import {
  joinMeetBot,
  resolveCallbackBaseUrl,
  stopMeetBot,
} from '#/lib/meet-bot-client'

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
/** Ongoing / overtime meetings need a long wait window. */
const MIN_WAIT_MS = 4 * 60 * 60 * 1000

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
        JSON.stringify({
          msg: 'workflow prepare',
          meetingId,
          botRunId,
          instanceId,
        }),
      )
      return { botRunId }
    })

    const wakeAt = Math.max(Date.now(), startsAtMs - FIVE_MIN_MS)
    if (wakeAt > Date.now() + 1_000) {
      console.log(
        JSON.stringify({
          msg: 'workflow sleep until T-5',
          meetingId,
          wakeAt: new Date(wakeAt).toISOString(),
        }),
      )
      await step.sleepUntil('wake-t-minus-5', wakeAt)
    }

    await step.do('launch', async () => {
      const database = db(this.env)
      await database
        .update(botRun)
        .set({ status: 'joining' })
        .where(eq(botRun.id, prepared.botRunId))

      const callbackBaseUrl = resolveCallbackBaseUrl(this.env.BETTER_AUTH_URL)
      const response = await joinMeetBot({
        meetingId,
        meetLink,
        displayName,
        botRunId: prepared.botRunId,
        endsAtMs,
        workflowInstanceId: instanceId,
        callbackBaseUrl,
        callbackSecret: this.env.BOT_INTERNAL_SECRET,
      })

      const responseText = await response.text()
      console.log(
        JSON.stringify({
          msg: 'workflow join response',
          meetingId,
          status: response.status,
          body: responseText.slice(0, 300),
        }),
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
      MIN_WAIT_MS,
    )
    const timeoutMinutes = Math.max(Math.ceil(timeoutMs / 60_000), 60)

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
      const skipOverwrite =
        existing?.status === 'left' &&
        done.status === 'failed' &&
        Boolean(done.errorMessage?.includes('Timed out'))

      if (!skipOverwrite) {
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
        await stopMeetBot(meetingId)
      } catch (error) {
        console.error('Failed to stop meet bot', error)
      }

      return { finalized: true }
    })
  }
}
