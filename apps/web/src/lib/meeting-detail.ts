import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { and, desc, eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { botRun, meeting, meetingNotes } from '#/db/schema'
import { parseAttendeesJson, type MeetingAttendee } from '#/lib/attendance'
import { getAuth } from '#/lib/auth'
import { getWorkflowStatus, formatWorkflowError } from '#/lib/schedule-bot'

export type ActionItem = {
  text: string
  assignee?: string | null
  dueDate?: string | null
}

export type MeetingDetail = {
  id: string
  title: string
  meetLink: string | null
  startsAt: Date
  endsAt: Date
  status: string
  htmlLink: string | null
  workflowInstanceId: string | null
  workflowStatus: string | null
  workflowError: string | null
  participants: Array<{
    email: string
    displayName: string | null
    responseStatus: string | null
  }>
  botRun: {
    id: string
    status: string
    joinedAt: Date | null
    leftAt: Date | null
    durationMs: number | null
    leaveReason: string | null
    uniqueAttendeeCount: number | null
    recordingKey: string | null
    transcriptKey: string | null
    transcriptText: string | null
    attendees: MeetingAttendee[]
    attendanceSyncStatus: string | null
    attendanceSyncError: string | null
    errorMessage: string | null
    createdAt: Date
  } | null
  notes: {
    id: string
    status: string
    summaryText: string | null
    actionItems: ActionItem[]
    errorMessage: string | null
  } | null
}

export const getMeetingDetail = createServerFn({ method: 'GET' })
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
    async ({
      data,
    }): Promise<{ meeting: MeetingDetail | null; error?: string }> => {
      const headers = getRequestHeaders()
      const auth = getAuth()
      const session = await auth.api.getSession({ headers })
      if (!session) {
        return { meeting: null, error: 'Not signed in' }
      }

      const row = await getDb().query.meeting.findFirst({
        where: and(
          eq(meeting.id, data.meetingId),
          eq(meeting.userId, session.user.id),
        ),
        with: {
          participants: true,
          botRuns: {
            orderBy: [desc(botRun.createdAt)],
          },
        },
      })

      if (!row) {
        return { meeting: null, error: 'Meeting not found' }
      }

      const latest =
        row.botRuns.find((r) => r.status === 'left') ??
        row.botRuns.find((r) => r.status === 'joined') ??
        row.botRuns[0] ??
        null

      let notesRow = null
      if (latest) {
        notesRow = await getDb().query.meetingNotes.findFirst({
          where: eq(meetingNotes.botRunId, latest.id),
          orderBy: [desc(meetingNotes.createdAt)],
        })
      }

      const wf = await getWorkflowStatus(row.workflowInstanceId)

      let actionItems: ActionItem[] = []
      if (notesRow?.actionItems) {
        try {
          actionItems = JSON.parse(notesRow.actionItems) as ActionItem[]
        } catch {
          actionItems = []
        }
      }

      return {
        meeting: {
          id: row.id,
          title: row.title,
          meetLink: row.meetLink,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          status: row.status,
          htmlLink: row.htmlLink,
          workflowInstanceId: row.workflowInstanceId,
          workflowStatus: wf?.status ?? null,
          workflowError: formatWorkflowError(wf?.error),
          participants: row.participants.map((p) => ({
            email: p.email,
            displayName: p.displayName,
            responseStatus: p.responseStatus,
          })),
          botRun: latest
            ? {
              id: latest.id,
              status: latest.status,
              joinedAt: latest.joinedAt,
              leftAt: latest.leftAt,
              durationMs: latest.durationMs ?? null,
              leaveReason: latest.leaveReason ?? null,
              uniqueAttendeeCount: latest.uniqueAttendeeCount ?? null,
              recordingKey: latest.recordingKey,
              transcriptKey: latest.transcriptKey,
              transcriptText: latest.transcriptText,
              attendees: parseAttendeesJson(latest.attendeesJson),
              attendanceSyncStatus: latest.attendanceSyncStatus,
              attendanceSyncError: latest.attendanceSyncError,
              errorMessage: latest.errorMessage,
              createdAt: latest.createdAt,
            }
            : null,
          notes: notesRow
            ? {
              id: notesRow.id,
              status: notesRow.status,
              summaryText: notesRow.summaryText,
              actionItems,
              errorMessage: notesRow.errorMessage,
            }
            : null,
        },
      }
    },
  )
