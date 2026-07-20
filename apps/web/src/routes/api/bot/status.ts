import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { botRun } from '#/db/schema'
import { isValidBotSecret, unauthorizedBot } from '#/lib/bot-auth'

export const Route = createFileRoute('/api/bot/status')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isValidBotSecret(request, env.BOT_INTERNAL_SECRET)) {
          return unauthorizedBot()
        }

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
