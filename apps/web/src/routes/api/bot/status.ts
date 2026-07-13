import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { botRun } from '#/db/schema'

function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 })
}

function assertBotSecret(request: Request) {
  const secret = request.headers.get('x-bot-secret')
  return Boolean(env.BOT_INTERNAL_SECRET) && secret === env.BOT_INTERNAL_SECRET
}

export const Route = createFileRoute('/api/bot/status')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!assertBotSecret(request)) return unauthorized()

        const body = (await request.json()) as {
          botRunId?: string
          status?: string
          errorMessage?: string
        }

        if (!body.botRunId || !body.status) {
          return Response.json({ error: 'Missing fields' }, { status: 400 })
        }

        const patch: {
          status: string
          errorMessage?: string | null
          joinedAt?: Date
        } = { status: body.status }

        if (body.errorMessage) {
          patch.errorMessage = body.errorMessage
        }
        if (body.status === 'joined') {
          patch.joinedAt = new Date()
        }

        await getDb()
          .update(botRun)
          .set(patch)
          .where(eq(botRun.id, body.botRunId))

        return Response.json({ ok: true })
      },
    },
  },
})
