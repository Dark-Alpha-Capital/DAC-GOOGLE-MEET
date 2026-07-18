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
  const expected = env.BOT_INTERNAL_SECRET
  if (!expected || !secret) return false
  if (secret.length !== expected.length) return false
  let mismatch = 0
  for (let i = 0; i < expected.length; i++) {
    mismatch |= secret.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return mismatch === 0
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

        const existing = await getDb().query.botRun.findFirst({
          where: eq(botRun.id, body.botRunId),
        })
        // Never downgrade a finished run back to joining/joined
        if (
          existing &&
          (existing.status === 'left' || existing.status === 'failed') &&
          body.status !== 'left' &&
          body.status !== 'failed'
        ) {
          return Response.json({
            ok: true,
            skipped: true,
            reason: `already ${existing.status}`,
          })
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
