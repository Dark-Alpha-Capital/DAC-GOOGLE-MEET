import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm'

import { getDb } from '#/db'
import { botRun, meeting, participant } from '#/db/schema'
import { getAuth } from '#/lib/auth'
import {
  getWorkflowStatus,
  formatWorkflowError,
  cancelMeetingBot,
} from '#/lib/schedule-bot'

export type BotRunSummary = {
  id: string
  status: string
  joinedAt: Date | null
  leftAt: Date | null
  recordingKey: string | null
  transcriptKey: string | null
  transcriptText: string | null
  errorMessage: string | null
  createdAt: Date
}

export type MeetingWithParticipants = {
  id: string
  googleEventId: string
  title: string
  meetLink: string | null
  startsAt: Date
  endsAt: Date
  status: string
  htmlLink: string | null
  workflowInstanceId: string | null
  workflowStatus: string | null
  workflowError: string | null
  botWakeAt: string | null
  latestBotRun: BotRunSummary | null
  participants: Array<{
    email: string
    displayName: string | null
    responseStatus: string | null
  }>
}

type GoogleAttendee = {
  email?: string
  displayName?: string
  responseStatus?: string
}

type GoogleEvent = {
  id?: string
  status?: string
  summary?: string
  htmlLink?: string
  hangoutLink?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  attendees?: GoogleAttendee[]
  conferenceData?: {
    entryPoints?: Array<{
      entryPointType?: string
      uri?: string
    }>
  }
}

type CalendarListResponse = {
  items?: GoogleEvent[]
  error?: { message?: string }
}

function newId() {
  return crypto.randomUUID()
}

function parseEventTime(value?: { dateTime?: string; date?: string }) {
  const raw = value?.dateTime ?? value?.date
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

function extractMeetLink(event: GoogleEvent): string | null {
  const videoEntry = event.conferenceData?.entryPoints?.find(
    (entry) => entry.entryPointType === 'video' && entry.uri,
  )
  if (videoEntry?.uri?.includes('meet.google.com')) {
    return videoEntry.uri
  }
  if (event.hangoutLink?.includes('meet.google.com')) {
    return event.hangoutLink
  }
  return null
}

async function getGoogleAccessToken(headers: Headers) {
  const auth = getAuth()
  const session = await auth.api.getSession({ headers })
  if (!session) {
    return { error: 'Not signed in' as const }
  }

  const tokenResult = await auth.api.getAccessToken({
    body: { providerId: 'google' },
    headers,
  })

  if (!tokenResult?.accessToken) {
    return {
      error: 'No Google access token. Sign out and sign in again.' as const,
    }
  }

  return { session, accessToken: tokenResult.accessToken }
}

async function fetchUpcomingGoogleEvents(accessToken: string) {
  const now = new Date()
  const inTwoWeeks = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: now.toISOString(),
    timeMax: inTwoWeeks.toISOString(),
    maxResults: '50',
    conferenceDataVersion: '1',
  })

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  )

  const data = (await response.json()) as CalendarListResponse
  if (!response.ok) {
    return {
      error:
        data.error?.message ?? `Calendar API error (${response.status})`,
    }
  }

  return { events: data.items ?? [] }
}

/** Upsert Meet-linked calendar events + invitees into D1. */
export const syncMeetingsFromCalendar = createServerFn({
  method: 'POST',
}).handler(async (): Promise<{
  synced: number
  removed: number
  error?: string
}> => {
  const headers = getRequestHeaders()
  const authResult = await getGoogleAccessToken(headers)
  if ('error' in authResult) {
    return { synced: 0, removed: 0, error: authResult.error }
  }

  const { session, accessToken } = authResult
  const calendarResult = await fetchUpcomingGoogleEvents(accessToken)
  if ('error' in calendarResult) {
    return { synced: 0, removed: 0, error: calendarResult.error }
  }

  const db = getDb()
  let synced = 0
  const seenGoogleIds = new Set<string>()
  const syncWindowEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)

  for (const event of calendarResult.events) {
    if (!event.id) continue

    const meetLink = extractMeetLink(event)
    if (!meetLink) continue

    const startsAt = parseEventTime(event.start)
    const endsAt = parseEventTime(event.end)
    if (!startsAt || !endsAt) continue

    seenGoogleIds.add(event.id)

    const existing = await db.query.meeting.findFirst({
      where: and(
        eq(meeting.userId, session.user.id),
        eq(meeting.googleEventId, event.id),
      ),
    })

    const status =
      event.status === 'cancelled'
        ? 'cancelled'
        : // Keep bot-completed meetings completed even if Calendar end is still in the future
          existing?.status === 'completed' || endsAt.getTime() < Date.now()
          ? 'completed'
          : 'scheduled'

    const meetingId = existing?.id ?? newId()

    if (existing) {
      await db
        .update(meeting)
        .set({
          title: event.summary ?? '(No title)',
          meetLink,
          startsAt,
          endsAt,
          status,
          htmlLink: event.htmlLink ?? null,
        })
        .where(eq(meeting.id, meetingId))
    } else {
      await db.insert(meeting).values({
        id: meetingId,
        userId: session.user.id,
        googleEventId: event.id,
        title: event.summary ?? '(No title)',
        meetLink,
        startsAt,
        endsAt,
        status,
        htmlLink: event.htmlLink ?? null,
      })
    }

    // Replace invitee snapshot for this meeting
    await db.delete(participant).where(eq(participant.meetingId, meetingId))

    const invitees = (event.attendees ?? []).filter((a) => a.email)
    if (invitees.length > 0) {
      await db.insert(participant).values(
        invitees.map((attendee) => ({
          id: newId(),
          meetingId,
          email: attendee.email!,
          displayName: attendee.displayName ?? null,
          responseStatus: attendee.responseStatus ?? null,
        })),
      )
    }

    // Bot workflows are started manually from the UI — never auto-schedule on sync.
    if (status === 'cancelled' && existing?.workflowInstanceId) {
      await cancelMeetingBot({
        meetingId,
        previousWorkflowInstanceId: existing.workflowInstanceId,
      })
      await db
        .update(meeting)
        .set({ workflowInstanceId: null })
        .where(eq(meeting.id, meetingId))
    }

    synced += 1
  }

  // Calendar deletions don't appear in the list API — drop locals that vanished.
  const staleLocals = await db.query.meeting.findMany({
    where: and(
      eq(meeting.userId, session.user.id),
      eq(meeting.status, 'scheduled'),
      gte(meeting.endsAt, new Date()),
      lte(meeting.startsAt, syncWindowEnd),
    ),
  })

  let removed = 0
  for (const local of staleLocals) {
    if (seenGoogleIds.has(local.googleEventId)) continue

    await cancelMeetingBot({
      meetingId: local.id,
      previousWorkflowInstanceId: local.workflowInstanceId,
    })

    await db
      .update(meeting)
      .set({ status: 'cancelled', workflowInstanceId: null })
      .where(eq(meeting.id, local.id))

    console.log(
      `[calendar] removed deleted meeting=${local.id} title=${local.title}`,
    )
    removed += 1
  }

  return { synced, removed }
})

export const getStoredMeetings = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{
    meetings: MeetingWithParticipants[]
    recent: MeetingWithParticipants[]
    error?: string
  }> => {
    const headers = getRequestHeaders()
    const auth = getAuth()
    const session = await auth.api.getSession({ headers })
    if (!session) {
      return { meetings: [], recent: [], error: 'Not signed in' }
    }

    // Window for day-by-day UI (prev/next day navigation).
    const windowStart = new Date()
    windowStart.setHours(0, 0, 0, 0)
    windowStart.setDate(windowStart.getDate() - 7)
    const windowEnd = new Date()
    windowEnd.setHours(23, 59, 59, 999)
    windowEnd.setDate(windowEnd.getDate() + 21)

    const rows = await getDb().query.meeting.findMany({
      where: and(
        eq(meeting.userId, session.user.id),
        gte(meeting.startsAt, windowStart),
        lte(meeting.startsAt, windowEnd),
        inArray(meeting.status, ['scheduled', 'completed', 'cancelled']),
      ),
      orderBy: [asc(meeting.startsAt)],
      with: {
        participants: true,
        botRuns: {
          orderBy: [desc(botRun.createdAt)],
        },
      },
    })

    const recentRows = await getDb().query.meeting.findMany({
      where: and(
        eq(meeting.userId, session.user.id),
        inArray(meeting.status, ['completed', 'cancelled']),
      ),
      orderBy: [desc(meeting.updatedAt)],
      limit: 20,
      with: {
        participants: true,
        botRuns: {
          orderBy: [desc(botRun.createdAt)],
        },
      },
    })

    async function toMeeting(
      row: (typeof rows)[number],
    ): Promise<MeetingWithParticipants> {
      const wf = await getWorkflowStatus(row.workflowInstanceId)
      const wakeMs = Math.max(
        Date.now(),
        row.startsAt.getTime() - 5 * 60 * 1000,
      )
      const latest =
        row.botRuns.find((r) => r.status === 'left') ??
        row.botRuns.find((r) => r.status === 'joined') ??
        row.botRuns[0] ??
        null
      return {
        id: row.id,
        googleEventId: row.googleEventId,
        title: row.title,
        meetLink: row.meetLink,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        status: row.status,
        htmlLink: row.htmlLink,
        workflowInstanceId: row.workflowInstanceId,
        workflowStatus: wf?.status ?? null,
        workflowError: formatWorkflowError(wf?.error),
        botWakeAt:
          row.status === 'scheduled'
            ? new Date(wakeMs).toISOString()
            : null,
        latestBotRun: latest
          ? {
              id: latest.id,
              status: latest.status,
              joinedAt: latest.joinedAt,
              leftAt: latest.leftAt,
              recordingKey: latest.recordingKey,
              transcriptKey: latest.transcriptKey,
              transcriptText: latest.transcriptText,
              errorMessage: latest.errorMessage,
              createdAt: latest.createdAt,
            }
          : null,
        participants: row.participants.map((p) => ({
          email: p.email,
          displayName: p.displayName,
          responseStatus: p.responseStatus,
        })),
      }
    }

    const meetings = await Promise.all(rows.map(toMeeting))
    const recent = await Promise.all(recentRows.map(toMeeting))

    return { meetings, recent }
  },
)
