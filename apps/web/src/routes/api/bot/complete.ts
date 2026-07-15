import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { botRun, meeting } from '#/db/schema'
import { getStorage } from '#/lib/storage'
import { transcribeAudio } from '#/lib/transcribe'
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

        const status: RecordingDonePayload['status'] =
          statusRaw === 'failed' ? 'failed' : 'left'

        let recordingKey: string | null = null
        let recordingUrl: string | null = null
        let transcriptKey: string | null = null
        let transcriptUrl: string | null = null
        let transcriptText: string | null = null
        let uploadError: string | null = null

        const meetingRow = await getDb().query.meeting.findFirst({
          where: eq(meeting.id, meetingId),
        })
        const titleSlug = slugify(meetingRow?.title ?? 'meeting')
        const day = dateStamp(meetingRow?.startsAt ?? new Date())
        const folder = `transcripts/${day}/${titleSlug}`

        if (file instanceof File && file.size > 0) {
          // Audio-only webm from the bot MediaRecorder (not full video)
          recordingKey = `${folder}/${botRunId}.webm`
          transcriptKey = `${folder}/${botRunId}.txt`
          try {
            const bytes = await file.arrayBuffer()
            const putAudio = await getStorage().put(recordingKey, bytes, {
              contentType: file.type || 'audio/webm',
            })
            recordingUrl = putAudio.url
            console.log(
              `[bot/complete] audio upload ok key=${recordingKey} size=${bytes.byteLength}`,
            )

            try {
              transcriptText = await transcribeAudio(env.AI, bytes)
              const putTxt = await getStorage().put(
                transcriptKey,
                transcriptText,
                { contentType: 'text/plain; charset=utf-8' },
              )
              transcriptUrl = putTxt.url
              console.log(
                `[bot/complete] transcript ok key=${transcriptKey} chars=${transcriptText.length}`,
              )
            } catch (error) {
              const msg =
                error instanceof Error ? error.message : String(error)
              console.error(`[bot/complete] transcription FAILED:`, msg)
              uploadError = `transcript: ${msg}`
              transcriptKey = null
              transcriptText = null
            }
          } catch (error) {
            uploadError =
              error instanceof Error ? error.message : String(error)
            console.error(
              `[bot/complete] audio upload FAILED key=${recordingKey}:`,
              uploadError,
            )
            recordingKey = null
            recordingUrl = null
            transcriptKey = null
          }
        } else {
          console.log(
            `[bot/complete] no audio file for botRun=${botRunId} status=${status}`,
          )
        }

        const combinedError =
          [errorMessage, uploadError]
            .filter(Boolean)
            .join(' | ') || null

        await getDb()
          .update(botRun)
          .set({
            status,
            recordingKey,
            transcriptKey,
            transcriptText,
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
          transcriptKey,
          transcriptUrl,
          transcriptPreview: transcriptText?.slice(0, 280) ?? null,
          status,
          uploadError,
        })
      },
    },
  },
})
