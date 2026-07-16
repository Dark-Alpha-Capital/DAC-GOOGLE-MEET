import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { summarizeMeeting } from '@repo/ai'

import * as schema from '#/db/schema'
import { botRun, meetingNotes } from '#/db/schema'

export type MeetingNotesParams = {
  notesId: string
  botRunId: string
  meetingId: string
}

function db(env: Env) {
  return drizzle(env.DB, { schema })
}

export class MeetingNotesWorkflow extends WorkflowEntrypoint<
  Env,
  MeetingNotesParams
> {
  async run(event: WorkflowEvent<MeetingNotesParams>, step: WorkflowStep) {
    const { notesId, botRunId, meetingId } = event.payload
    const instanceId = event.instanceId

    await step.do('mark-running', async () => {
      const database = db(this.env)
      await database
        .update(meetingNotes)
        .set({
          status: 'running',
          workflowInstanceId: instanceId,
          errorMessage: null,
        })
        .where(eq(meetingNotes.id, notesId))
      return { ok: true }
    })

    const transcript = await step.do('load-transcript', async () => {
      const database = db(this.env)
      const run = await database.query.botRun.findFirst({
        where: eq(botRun.id, botRunId),
      })
      const text = run?.transcriptText?.trim() ?? ''
      if (!text) {
        throw new Error(
          `No transcriptText on bot_run=${botRunId} — cannot generate notes`,
        )
      }
      return { text }
    })

    try {
      const notes = await step.do('summarize', async () => {
        const apiKey = this.env.OPENAI_API_KEY
        if (!apiKey) {
          throw new Error('OPENAI_API_KEY is not configured')
        }
        const result = await summarizeMeeting(transcript.text, apiKey)
        return {
          summary: result.summary,
          actionItems: JSON.stringify(result.actionItems),
        }
      })

      await step.do('save-notes', async () => {
        const database = db(this.env)
        await database
          .update(meetingNotes)
          .set({
            status: 'ready',
            summaryText: notes.summary,
            actionItems: notes.actionItems,
            errorMessage: null,
          })
          .where(eq(meetingNotes.id, notesId))
        console.log(
          `[notes-workflow] ready meeting=${meetingId} botRun=${botRunId} notes=${notesId}`,
        )
        return { ok: true }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await step.do('mark-failed', async () => {
        const database = db(this.env)
        await database
          .update(meetingNotes)
          .set({
            status: 'failed',
            errorMessage: message,
          })
          .where(eq(meetingNotes.id, notesId))
        return { ok: true }
      })
      throw error
    }
  }
}
