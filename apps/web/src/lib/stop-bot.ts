import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { and, desc, eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { botRun, meeting } from '#/db/schema'
import { getAuth } from '#/lib/auth'
import { stopMeetBot } from '#/lib/meet-bot-client'
import { cancelMeetingBot } from '#/lib/schedule-bot'

const ACTIVE_RUN_STATUSES = new Set([
  'pending',
  'joining',
  'waiting_admission',
  'joined',
])

/** User-triggered: cancel scheduled/running bot for this meeting. */
export const stopBotForMeeting = createServerFn({ method: 'POST' })
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
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
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

    try {
      await cancelMeetingBot({
        meetingId: row.id,
        previousWorkflowInstanceId: row.workflowInstanceId,
      })
      try {
        await stopMeetBot(row.id)
      } catch (error) {
        console.error('[stopBot] container stop failed', error)
      }

      const latest = await getDb().query.botRun.findFirst({
        where: eq(botRun.meetingId, row.id),
        orderBy: [desc(botRun.createdAt)],
      })
      if (latest && ACTIVE_RUN_STATUSES.has(latest.status)) {
        await getDb()
          .update(botRun)
          .set({
            status: 'failed',
            errorMessage: 'Stopped by user',
            leftAt: new Date(),
          })
          .where(eq(botRun.id, latest.id))
      }

      await getDb()
        .update(meeting)
        .set({ workflowInstanceId: null })
        .where(eq(meeting.id, row.id))

      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[stopBotForMeeting] failed:', message)
      return { ok: false, error: message }
    }
  })
