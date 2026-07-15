import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { botRun, meeting } from '#/db/schema'
import { getStorage } from '#/lib/storage'
import type { RecordingDonePayload } from '#/workflows/meeting-bot'

function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 })
}

function assertBotSecret(request: Request) {
  const secret = request.headers.get('x-bot-secret')
  return Boolean(env.BOT_INTERNAL_SECRET) && secret === env.BOT_INTERNAL_SECRET
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'meeting'
}

function dateStamp(date: Date) {
  return date.toISOString().slice(0, 10)
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

        let status: RecordingDonePayload['status'] =
          statusRaw === 'failed' ? 'failed' : 'left'

        let recordingKey: string | null = null
        let recordingUrl: string | null = null
        let uploadError: string | null = null

        const meetingRow = await getDb().query.meeting.findFirst({
          where: eq(meeting.id, meetingId),
        })
        const titleSlug = slugify(meetingRow?.title ?? 'meeting')
        const day = dateStamp(meetingRow?.startsAt ?? new Date())

        if (file instanceof File && file.size > 0) {
          recordingKey = `recordings/${day}/${titleSlug}/${botRunId}.webm`
          try {
            const bytes = await file.arrayBuffer()
            const put = await getStorage().put(recordingKey, bytes, {
              contentType: file.type || 'audio/webm',
            })
            recordingUrl = put.url
            console.log(
              `[bot/complete] Nextcloud upload ok key=${recordingKey} url=${recordingUrl} size=${bytes.byteLength}`,
            )
          } catch (error) {
            uploadError =
              error instanceof Error ? error.message : String(error)
            console.error(
              `[bot/complete] Nextcloud upload FAILED key=${recordingKey}:`,
              uploadError,
            )
            // Keep status as left/failed so workflow can finalize; surface upload error
            recordingKey = null
            recordingUrl = null
          }
        } else {
          console.log(
            `[bot/complete] no recording file for botRun=${botRunId} status=${status}`,
          )
        }

        const combinedError =
          [errorMessage, uploadError ? `upload: ${uploadError}` : null]
            .filter(Boolean)
            .join(' | ') || null

        // If upload failed on an otherwise successful leave, still mark left
        // so UI/DB leave the "joined/recording" state.
        if (uploadError && status === 'left' && !errorMessage) {
          // leave status stays — recording just missing
        }

        await getDb()
          .update(botRun)
          .set({
            status,
            recordingKey,
            errorMessage: combinedError,
            leftAt: new Date(),
          })
          .where(eq(botRun.id, botRunId))

        if (status === 'left') {
          await getDb()
            .update(meeting)
            .set({ status: 'completed' })
            .where(eq(meeting.id, meetingId))
        }

        const payload: RecordingDonePayload = {
          botRunId,
          recordingKey,
          status,
          errorMessage: combinedError ?? undefined,
        }

        try {
          const instance =
            await env.MEETING_BOT_WORKFLOW.get(workflowInstanceId)
          await instance.sendEvent({
            type: 'recording-done',
            payload,
          })
        } catch (error) {
          console.error(
            `[bot/complete] sendEvent failed for ${workflowInstanceId}:`,
            error,
          )
        }

        return Response.json({
          ok: true,
          recordingKey,
          recordingUrl,
          uploadError,
          status,
        })
      },
    },
  },
})
