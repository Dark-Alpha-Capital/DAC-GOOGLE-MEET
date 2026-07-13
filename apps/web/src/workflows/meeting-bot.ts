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

      return { botRunId }
    })

    const wakeAt = Math.max(Date.now(), startsAtMs - FIVE_MIN_MS)
    await step.sleepUntil('wake-t-minus-5', wakeAt)

    await step.do('launch', async () => {
      const database = db(this.env)
      await database
        .update(botRun)
        .set({ status: 'joining' })
        .where(eq(botRun.id, prepared.botRunId))

      const container = getContainer(
        this.env.MEET_BOT_CONTAINER as DurableObjectNamespace<Container>,
        meetingId,
      )
      await container.startAndWaitForPorts()

      const callbackBaseUrl = this.env.BETTER_AUTH_URL.replace(/\/$/, '')
      const response = await container.fetch(
        new Request('http://container/join', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            meetingId,
            meetLink,
            displayName,
            botRunId: prepared.botRunId,
            endsAtMs,
            workflowInstanceId: instanceId,
            callbackBaseUrl,
            callbackSecret: this.env.BOT_INTERNAL_SECRET,
          }),
        }),
      )

      if (!response.ok) {
        const text = await response.text()
        await database
          .update(botRun)
          .set({
            status: 'failed',
            errorMessage: `Launch failed: ${text}`,
          })
          .where(eq(botRun.id, prepared.botRunId))
        throw new Error(`Bot launch failed (${response.status}): ${text}`)
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

      await database
        .update(botRun)
        .set({
          status: done.status,
          recordingKey: done.recordingKey,
          errorMessage: done.errorMessage ?? null,
          leftAt: now,
        })
        .where(eq(botRun.id, prepared.botRunId))

      if (done.status === 'left') {
        await database
          .update(meeting)
          .set({ status: 'completed' })
          .where(eq(meeting.id, meetingId))
      }

      try {
        const container = getContainer(
          this.env.MEET_BOT_CONTAINER as DurableObjectNamespace<Container>,
          meetingId,
        )
        await container.fetch(
          new Request('http://container/stop', { method: 'POST' }),
        )
      } catch (error) {
        console.error('Failed to stop meet bot container', error)
      }

      return { finalized: true }
    })
  }
}
