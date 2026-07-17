import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { and, eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { meeting } from '#/db/schema'
import { getAuth } from '#/lib/auth'
import { scheduleMeetingBot } from '#/lib/schedule-bot'

/** User-triggered: schedule the notetaker workflow for this meeting. */
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
      if (row.status !== 'scheduled' && row.status !== 'completed') {
        return {
          ok: false,
          error: `Meeting is ${row.status} — cannot schedule a bot`,
        }
      }
      // Overtime / just-ended calendar events are still joinable for a few hours.
      if (
        row.status === 'completed' &&
        Date.now() > row.endsAt.getTime() + 4 * 60 * 60 * 1000
      ) {
        return {
          ok: false,
          error: 'Meeting ended too long ago to schedule a bot',
        }
      }

      try {
        const now = Date.now()
        const started = row.startsAt.getTime()
        const calendarEnd = row.endsAt.getTime()
        // Ongoing (or overtime) meetings: join immediately with a long runtime window.
        const ongoing = now >= started - 5 * 60 * 1000
        const endsAt = ongoing
          ? new Date(Math.max(calendarEnd, now + 4 * 60 * 60 * 1000))
          : row.endsAt

        const workflowInstanceId = await scheduleMeetingBot({
          meetingId: row.id,
          meetLink: row.meetLink,
          // Force immediate wake for ongoing meetings.
          startsAt: ongoing ? new Date(Math.min(started, now)) : row.startsAt,
          endsAt,
          status: 'scheduled',
          // Only treat as "previous schedule" when a workflow was already stored.
          previousStartsAtMs: row.workflowInstanceId
            ? row.startsAt.getTime()
            : undefined,
          previousMeetLink: row.workflowInstanceId ? row.meetLink : undefined,
          previousWorkflowInstanceId: row.workflowInstanceId,
        })

        if (!workflowInstanceId) {
          return {
            ok: false,
            error: 'Could not schedule bot for this meeting',
          }
        }

        await getDb()
          .update(meeting)
          .set({ workflowInstanceId })
          .where(eq(meeting.id, row.id))

        console.log(
          `[requestBotForMeeting] scheduled meeting=${row.id} ongoing=${ongoing} endsAt=${endsAt.toISOString()} instance=${workflowInstanceId}`,
        )
        return { ok: true, workflowInstanceId }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[requestBotForMeeting] failed:', message)
        return { ok: false, error: message }
      }
    },
  )
