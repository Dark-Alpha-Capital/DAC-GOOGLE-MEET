import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { and, desc, eq } from 'drizzle-orm'
import { Container, getContainer } from '@cloudflare/containers'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db'
import { botRun, meeting } from '#/db/schema'
import { getAuth } from '#/lib/auth'
import { cancelMeetingBot } from '#/lib/schedule-bot'

async function stopBotProcess(meetingId: string) {
  const secret = env.BOT_INTERNAL_SECRET
  const headers: Record<string, string> = {}
  if (secret) headers['x-bot-secret'] = secret

  const hostUrl = (
    (env as Env & { MEET_BOT_URL?: string }).MEET_BOT_URL || ''
  ).replace(/\/$/, '')
  if (hostUrl) {
    await fetch(`${hostUrl}/stop`, { method: 'POST', headers })
    return
  }

  try {
    const container = getContainer(
      env.MEET_BOT_CONTAINER as unknown as DurableObjectNamespace<Container>,
      meetingId,
    )
    await container.fetch(
      new Request('http://container/stop', { method: 'POST', headers }),
    )
  } catch (error) {
    console.error('[stopBot] container stop failed', error)
  }
}

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
  .handler(
    async ({ data }): Promise<{ ok: boolean; error?: string }> => {
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
        await stopBotProcess(row.id)

        const latest = await getDb().query.botRun.findFirst({
          where: eq(botRun.meetingId, row.id),
          orderBy: [desc(botRun.createdAt)],
        })
        if (
          latest &&
          (latest.status === 'pending' ||
            latest.status === 'joining' ||
            latest.status === 'waiting_admission' ||
            latest.status === 'joined')
        ) {
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
    },
  )
