import { createFileRoute } from '@tanstack/react-router'
import { Container, getContainer } from '@cloudflare/containers'
import { env } from 'cloudflare:workers'

import { cancelMeetingBot } from '#/lib/schedule-bot'

function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 })
}

function assertBotSecret(request: Request) {
  const secret = request.headers.get('x-bot-secret')
  const expected = env.BOT_INTERNAL_SECRET
  if (!expected || !secret) return false
  if (secret.length !== expected.length) return false
  let mismatch = 0
  for (let i = 0; i < expected.length; i++) {
    mismatch |= secret.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return mismatch === 0
}

/**
 * Ops endpoint: force-stop a meet-bot container + terminate its workflow.
 * Auth: x-bot-secret (BOT_INTERNAL_SECRET). Body: { meetingId: string }
 */
export const Route = createFileRoute('/api/bot/force-stop')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!assertBotSecret(request)) return unauthorized()

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
          const container = getContainer(
            env.MEET_BOT_CONTAINER as unknown as DurableObjectNamespace<Container>,
            meetingId,
          )
          await container.fetch(
            new Request('http://container/stop', {
              method: 'POST',
              headers: {
                'x-bot-secret': env.BOT_INTERNAL_SECRET,
              },
            }),
          )
        } catch (error) {
          console.error('[force-stop] container stop failed', error)
        }

        return Response.json({ ok: true, meetingId })
      },
    },
  },
})
