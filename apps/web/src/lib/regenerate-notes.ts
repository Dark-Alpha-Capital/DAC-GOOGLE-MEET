import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { env } from 'cloudflare:workers'
import { and, desc, eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { botRun, meeting, meetingNotes } from '#/db/schema'
import { getAuth } from '#/lib/auth'

/**
 * User-triggered: re-run the AI notes (summary + action items) workflow for a
 * meeting whose transcript already exists. Used to recover from a failed notes
 * run or to regenerate after a transcript change.
 */
export const regenerateNotes = createServerFn({ method: 'POST' })
  .validator((data: unknown) => {
    const meetingId =
      typeof data === 'object' &&
      data &&
      'meetingId' in data &&
      typeof (data as { meetingId: unknown }).meetingId === 'string'
        ? (data as { meetingId: string }).meetingId
        : ''
    if (!meetingId) throw new Error('meetingId required')
    return { meetingId }
  })
  .handler(
    async ({
      data,
    }): Promise<{ ok: boolean; notesId?: string; error?: string }> => {
      const headers = getRequestHeaders()
      const session = await getAuth().api.getSession({ headers })
      if (!session) {
        return { ok: false, error: 'Not signed in' }
      }

      // Only operate on a meeting the caller owns.
      const row = await getDb().query.meeting.findFirst({
        where: and(
          eq(meeting.id, data.meetingId),
          eq(meeting.userId, session.user.id),
        ),
        with: {
          botRuns: {
            orderBy: [desc(botRun.createdAt)],
          },
        },
      })
      if (!row) {
        return { ok: false, error: 'Meeting not found' }
      }

      // Notes need a transcript — pick the most recent run that has one.
      const runWithTranscript = row.botRuns.find(
        (r) => (r.transcriptText?.trim().length ?? 0) > 0,
      )
      if (!runWithTranscript) {
        return { ok: false, error: 'No transcript available to summarize yet' }
      }

      try {
        // ponytail: inserts a fresh notes row per retry (matches the bot-side
        // startNotesWorkflow pattern); CF workflow ids are one-shot so we cannot
        // reuse the old instance id. Old failed rows are harmless — the detail
        // loader always reads the newest row for this bot run.
        const notesId = crypto.randomUUID()
        const instanceId = `notes-${runWithTranscript.id}-${Date.now()}`

        await getDb().insert(meetingNotes).values({
          id: notesId,
          botRunId: runWithTranscript.id,
          meetingId: row.id,
          status: 'pending',
          workflowInstanceId: instanceId,
        })

        await env.MEETING_NOTES_WORKFLOW.create({
          id: instanceId,
          params: {
            notesId,
            botRunId: runWithTranscript.id,
            meetingId: row.id,
          },
        })

        console.log(
          `[regenerateNotes] started notes workflow ${instanceId} notes=${notesId} meeting=${row.id}`,
        )
        return { ok: true, notesId }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[regenerateNotes] failed:', message)
        return { ok: false, error: message }
      }
    },
  )
