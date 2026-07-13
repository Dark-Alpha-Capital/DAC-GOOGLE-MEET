import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { botRun } from '#/db/schema'
import { getStorage } from '#/lib/storage'
import type { RecordingDonePayload } from '#/workflows/meeting-bot'

function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 })
}

function assertBotSecret(request: Request) {
  const secret = request.headers.get('x-bot-secret')
  return Boolean(env.BOT_INTERNAL_SECRET) && secret === env.BOT_INTERNAL_SECRET
}

export const Route = createFileRoute('/api/bot/complete')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!assertBotSecret(request)) return unauthorized()

        const form = await request.formData()
        const botRunId = String(form.get('botRunId') ?? '')
        const meetingId = String(form.get('meetingId') ?? '')
        const workflowInstanceId = String(form.get('workflowInstanceId') ?? '')
        const statusRaw = String(form.get('status') ?? 'left')
        const errorMessage = form.get('errorMessage')
          ? String(form.get('errorMessage'))
          : undefined
        const file = form.get('recording')

        if (!botRunId || !meetingId || !workflowInstanceId) {
          return Response.json({ error: 'Missing fields' }, { status: 400 })
        }

        const status: RecordingDonePayload['status'] =
          statusRaw === 'failed' ? 'failed' : 'left'

        let recordingKey: string | null = null

        if (file instanceof File && file.size > 0) {
          recordingKey = `recordings/${meetingId}/${botRunId}.webm`
          await getStorage().put(recordingKey, file, {
            contentType: file.type || 'audio/webm',
          })
        }

        await getDb()
          .update(botRun)
          .set({
            status,
            recordingKey,
            errorMessage: errorMessage ?? null,
            leftAt: new Date(),
          })
          .where(eq(botRun.id, botRunId))

        const payload: RecordingDonePayload = {
          botRunId,
          recordingKey,
          status,
          errorMessage,
        }

        const instance = await env.MEETING_BOT_WORKFLOW.get(workflowInstanceId)
        await instance.sendEvent({
          type: 'recording-done',
          payload,
        })

        return Response.json({ ok: true, recordingKey })
      },
    },
  },
})
