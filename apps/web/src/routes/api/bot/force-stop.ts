import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { isValidBotSecret, unauthorizedBot } from '#/lib/bot-auth'
import { stopMeetBot } from '#/lib/meet-bot-client'
import { cancelMeetingBot } from '#/lib/schedule-bot'

/**
 * Ops endpoint: force-stop a meet-bot container + terminate its workflow.
 * Auth: x-bot-secret (BOT_INTERNAL_SECRET). Body: { meetingId: string }
 */
export const Route = createFileRoute('/api/bot/force-stop')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isValidBotSecret(request, env.BOT_INTERNAL_SECRET)) {
          return unauthorizedBot()
        }

        const body = (await request.json().catch(() => null)) as {
          meetingId?: string
          workflowInstanceId?: string | null
        } | null
        const meetingId = body?.meetingId?.trim()
        if (!meetingId) {
          return Response.json({ error: 'meetingId required' }, { status: 400 })
        }

        await cancelMeetingBot({
          meetingId,
          previousWorkflowInstanceId: body?.workflowInstanceId ?? meetingId,
        })

        try {
          await stopMeetBot(meetingId)
        } catch (error) {
          console.error('[force-stop] container stop failed', error)
        }

        return Response.json({ ok: true, meetingId })
      },
    },
  },
})
