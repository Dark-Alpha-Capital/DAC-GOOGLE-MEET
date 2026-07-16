import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { and, eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { meeting } from '#/db/schema'
import { getAuth } from '#/lib/auth'
import { scheduleMeetingBot } from '#/lib/schedule-bot'

/** User-triggered: send the notetaker bot to this meeting. */
export const requestBotForMeeting = createServerFn({ method: 'POST' })
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
    }): Promise<{
      ok: boolean
      workflowInstanceId?: string | null
      error?: string
    }> => {
      const headers = getRequestHeaders()
      const session = await getAuth().api.getSession({ headers })
      if (!session) {
        return { ok: false, error: 'Not signed in' }
      }

      const row = await getDb().query.meeting.findFirst({
        where: and(
          eq(meeting.id, data.meetingId),
          eq(meeting.userId, session.user.id),
        ),
      })
      if (!row) {
        return { ok: false, error: 'Meeting not found' }
      }
      if (!row.meetLink) {
        return { ok: false, error: 'Meeting has no Google Meet link' }
      }
      if (row.status !== 'scheduled') {
        return {
          ok: false,
          error: `Meeting is ${row.status} — only scheduled meetings can get a bot`,
        }
      }

      try {
        const workflowInstanceId = await scheduleMeetingBot({
          meetingId: row.id,
          meetLink: row.meetLink,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          status: row.status,
          previousStartsAtMs: row.startsAt.getTime(),
          previousMeetLink: row.meetLink,
          previousWorkflowInstanceId: row.workflowInstanceId,
        })

        await getDb()
          .update(meeting)
          .set({ workflowInstanceId })
          .where(eq(meeting.id, row.id))

        return { ok: true, workflowInstanceId }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[requestBotForMeeting] failed:', message)
        return { ok: false, error: message }
      }
    },
  )
