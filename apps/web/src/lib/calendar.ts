import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { and, asc, eq, gte } from 'drizzle-orm'

import { getDb } from '#/db'
import { meeting, participant } from '#/db/schema'
import { getAuth } from '#/lib/auth'
import { scheduleMeetingBot } from '#/lib/schedule-bot'

export type MeetingWithParticipants = {
  id: string
  googleEventId: string
  title: string
  meetLink: string | null
  startsAt: Date
  endsAt: Date
  status: string
  htmlLink: string | null
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
}).handler(async (): Promise<{ synced: number; error?: string }> => {
  const headers = getRequestHeaders()
  const authResult = await getGoogleAccessToken(headers)
  if ('error' in authResult) {
    return { synced: 0, error: authResult.error }
  }

  const { session, accessToken } = authResult
  const calendarResult = await fetchUpcomingGoogleEvents(accessToken)
  if ('error' in calendarResult) {
    return { synced: 0, error: calendarResult.error }
  }

  const db = getDb()
  let synced = 0

  for (const event of calendarResult.events) {
    if (!event.id) continue

    const meetLink = extractMeetLink(event)
    if (!meetLink) continue

    const startsAt = parseEventTime(event.start)
    const endsAt = parseEventTime(event.end)
    if (!startsAt || !endsAt) continue

    const status =
      event.status === 'cancelled'
        ? 'cancelled'
        : endsAt.getTime() < Date.now()
          ? 'completed'
          : 'scheduled'

    const existing = await db.query.meeting.findFirst({
      where: and(
        eq(meeting.userId, session.user.id),
        eq(meeting.googleEventId, event.id),
      ),
    })

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

    const workflowInstanceId = await scheduleMeetingBot({
      meetingId,
      meetLink,
      startsAt,
      endsAt,
      status,
      previousStartsAtMs: existing?.startsAt.getTime(),
      previousMeetLink: existing?.meetLink,
      previousWorkflowInstanceId: existing?.workflowInstanceId,
    })

    await db
      .update(meeting)
      .set({ workflowInstanceId })
      .where(eq(meeting.id, meetingId))

    synced += 1
  }

  return { synced }
})

export const getStoredMeetings = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{
    meetings: MeetingWithParticipants[]
    error?: string
  }> => {
    const headers = getRequestHeaders()
    const auth = getAuth()
    const session = await auth.api.getSession({ headers })
    if (!session) {
      return { meetings: [], error: 'Not signed in' }
    }

    const rows = await getDb().query.meeting.findMany({
      where: and(
        eq(meeting.userId, session.user.id),
        gte(meeting.endsAt, new Date()),
      ),
      orderBy: [asc(meeting.startsAt)],
      with: {
        participants: true,
      },
    })

    return {
      meetings: rows.map((row) => ({
        id: row.id,
        googleEventId: row.googleEventId,
        title: row.title,
        meetLink: row.meetLink,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        status: row.status,
        htmlLink: row.htmlLink,
        participants: row.participants.map((p) => ({
          email: p.email,
          displayName: p.displayName,
          responseStatus: p.responseStatus,
        })),
      })),
    }
  },
)
