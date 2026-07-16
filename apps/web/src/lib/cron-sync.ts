import { and, eq, gte } from 'drizzle-orm'

import { getDb } from '#/db'
import { meeting } from '#/db/schema'
import { scheduleMeetingBot } from '#/lib/schedule-bot'

/**
 * Cron helper: ensure every upcoming scheduled meeting has a live workflow.
 * Does not call Google Calendar (token refresh needs a user session) —
 * the dashboard sync still pulls events; this catches missed schedules.
 */
export async function rescheduleUpcomingMeetings() {
  const database = getDb()
  const now = new Date()

  const rows = await database.query.meeting.findMany({
    where: and(eq(meeting.status, 'scheduled'), gte(meeting.endsAt, now)),
  })

  let scheduled = 0
  for (const row of rows) {
    if (!row.meetLink) continue
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
    if (workflowInstanceId && workflowInstanceId !== row.workflowInstanceId) {
      await database
        .update(meeting)
        .set({ workflowInstanceId })
        .where(eq(meeting.id, row.id))
    }
    if (workflowInstanceId) scheduled += 1
  }

  console.log(
    `[cron] rescheduleUpcomingMeetings meetings=${rows.length} withWorkflow=${scheduled}`,
  )
  return { meetings: rows.length, scheduled }
}
