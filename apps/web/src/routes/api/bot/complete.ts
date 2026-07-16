import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { transcribeAudio } from '@repo/ai'

import { getDb } from '#/db'
import { botRun, meeting, meetingNotes } from '#/db/schema'
import {
  parseAttendeesJson,
  recordAttendance,
  type MeetingAttendee,
} from '#/lib/attendance'
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

async function sendRecordingDoneWithRetry(
  workflowInstanceId: string,
  payload: RecordingDonePayload,
  attempts = 3,
) {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const instance = await env.MEETING_BOT_WORKFLOW.get(workflowInstanceId)
      await instance.sendEvent({
        type: 'recording-done',
        payload,
      })
      return
    } catch (error) {
      lastError = error
      console.error(
        `[bot/complete] sendEvent attempt ${i + 1}/${attempts} failed:`,
        error,
      )
    }
  }
  throw lastError
}

async function startNotesWorkflow(input: {
  botRunId: string
  meetingId: string
  hasTranscript: boolean
}) {
  if (!input.hasTranscript) {
    console.log(
      `[bot/complete] skip notes workflow — no transcript for botRun=${input.botRunId}`,
    )
    return null
  }

  const notesId = crypto.randomUUID()
  const instanceId = `notes-${input.botRunId}-${Date.now()}`

  await getDb().insert(meetingNotes).values({
    id: notesId,
    botRunId: input.botRunId,
    meetingId: input.meetingId,
    status: 'pending',
    workflowInstanceId: instanceId,
  })

  await env.MEETING_NOTES_WORKFLOW.create({
    id: instanceId,
    params: {
      notesId,
      botRunId: input.botRunId,
      meetingId: input.meetingId,
    },
  })

  console.log(
    `[bot/complete] started notes workflow ${instanceId} notes=${notesId}`,
  )
  return { notesId, instanceId }
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
        const attendeesRaw = form.get('attendees')
          ? String(form.get('attendees'))
          : ''
        const attendees: MeetingAttendee[] = attendeesRaw
          ? parseAttendeesJson(attendeesRaw)
          : []

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
              const apiKey = env.OPENAI_API_KEY
              if (!apiKey) {
                throw new Error('OPENAI_API_KEY is not configured')
              }
              transcriptText = await transcribeAudio(
                {
                  bytes,
                  filename: `${botRunId}.webm`,
                  contentType: file.type || 'audio/webm',
                },
                apiKey,
              )
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
          [errorMessage, uploadError].filter(Boolean).join(' | ') || null

        let attendanceSyncStatus: string | null = null
        let attendanceSyncError: string | null = null

        if (status === 'left') {
          try {
            const attendanceResult = await recordAttendance(
              {
                meetingId,
                botRunId,
                title: meetingRow?.title ?? 'meeting',
                meetLink: meetingRow?.meetLink ?? null,
                startedAt: meetingRow?.startsAt?.toISOString() ?? null,
                endedAt: new Date().toISOString(),
                attendees,
              },
              {
                apiUrl: env.ATTENDANCE_API_URL,
                apiKey: env.ATTENDANCE_API_KEY,
              },
            )
            attendanceSyncStatus = attendanceResult.mode
          } catch (error) {
            attendanceSyncStatus = 'failed'
            attendanceSyncError =
              error instanceof Error ? error.message : String(error)
            console.error('[bot/complete] attendance sync FAILED:', attendanceSyncError)
          }
        } else {
          attendanceSyncStatus = 'skipped'
        }

        await getDb()
          .update(botRun)
          .set({
            status,
            recordingKey,
            transcriptKey,
            transcriptText,
            attendeesJson:
              attendees.length > 0 ? JSON.stringify(attendees) : null,
            attendanceSyncStatus,
            attendanceSyncError,
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
          await sendRecordingDoneWithRetry(workflowInstanceId, payload)
        } catch (error) {
          console.error(
            `[bot/complete] sendEvent exhausted for ${workflowInstanceId}:`,
            error,
          )
        }

        let notes: { notesId: string; instanceId: string } | null = null
        if (status === 'left' && transcriptText) {
          try {
            notes = await startNotesWorkflow({
              botRunId,
              meetingId,
              hasTranscript: true,
            })
          } catch (error) {
            console.error('[bot/complete] failed to start notes workflow', error)
          }
        }

        return Response.json({
          ok: true,
          recordingKey,
          recordingUrl,
          transcriptKey,
          transcriptUrl,
          transcriptPreview: transcriptText?.slice(0, 280) ?? null,
          notesId: notes?.notesId ?? null,
          attendeesCount: attendees.length,
          attendanceSyncStatus,
          status,
          uploadError,
        })
      },
    },
  },
})
