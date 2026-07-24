import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'

import { getAuth } from '#/lib/auth'

const MEET_SCOPE = 'https://www.googleapis.com/auth/meetings.space.readonly'
const MEET_API = 'https://meet.googleapis.com/v2'

export type MeetParticipantKind = 'signedin' | 'anonymous' | 'phone' | 'unknown'

export type MeetParticipantSession = {
  name: string
  startTime: string | null
  endTime: string | null
  durationMs: number | null
}

export type MeetAttendanceParticipant = {
  name: string
  displayName: string
  kind: MeetParticipantKind
  userId: string | null
  earliestStartTime: string | null
  latestEndTime: string | null
  sessionCount: number
  totalDurationMs: number | null
  sessions: MeetParticipantSession[]
}

export type MeetConferenceSummary = {
  id: string
  name: string
  startTime: string | null
  endTime: string | null
  space: string | null
  participantCount: number
}

export type MeetAttendanceConference = MeetConferenceSummary & {
  participants: MeetAttendanceParticipant[]
}

type GoogleApiError = {
  error?: { message?: string; status?: string }
}

type ConferenceRecord = {
  name?: string
  startTime?: string
  endTime?: string
  space?: string
}

type ConferenceRecordsResponse = GoogleApiError & {
  conferenceRecords?: ConferenceRecord[]
}

type SignedInUser = {
  user?: string
  displayName?: string
}

type AnonymousUser = {
  displayName?: string
}

type PhoneUser = {
  displayName?: string
}

type ParticipantRecord = {
  name?: string
  earliestStartTime?: string
  latestEndTime?: string
  signedinUser?: SignedInUser
  anonymousUser?: AnonymousUser
  phoneUser?: PhoneUser
}

type ParticipantsResponse = GoogleApiError & {
  participants?: ParticipantRecord[]
}

type ParticipantSessionRecord = {
  name?: string
  startTime?: string
  endTime?: string
}

type ParticipantSessionsResponse = GoogleApiError & {
  participantSessions?: ParticipantSessionRecord[]
}

/** `conferenceRecords/{id}` → `{id}` for URL params. */
export function conferenceRecordId(name: string): string {
  const prefix = 'conferenceRecords/'
  return name.startsWith(prefix) ? name.slice(prefix.length) : name
}

/** URL id → full resource name. */
export function conferenceRecordName(id: string): string {
  const cleaned = id.replace(/^conferenceRecords\//, '')
  return `conferenceRecords/${cleaned}`
}

function durationMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return null
  return endMs - startMs
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

  if (!tokenResult.accessToken) {
    return {
      error: 'No Google access token. Sign out and sign in again.' as const,
    }
  }

  const grantedScope =
    typeof tokenResult.scope === 'string' ? tokenResult.scope : ''
  if (grantedScope && !grantedScope.includes(MEET_SCOPE)) {
    return {
      error:
        'Meet access not granted. Sign out and sign in again to grant Meet attendance permission.' as const,
    }
  }

  return { session, accessToken: tokenResult.accessToken }
}

function mapParticipantBase(p: ParticipantRecord) {
  if (p.signedinUser) {
    return {
      name: p.name ?? '',
      displayName: p.signedinUser.displayName ?? 'Unknown',
      kind: 'signedin' as const,
      userId: p.signedinUser.user ?? null,
      earliestStartTime: p.earliestStartTime ?? null,
      latestEndTime: p.latestEndTime ?? null,
    }
  }
  if (p.anonymousUser) {
    return {
      name: p.name ?? '',
      displayName: p.anonymousUser.displayName ?? 'Anonymous',
      kind: 'anonymous' as const,
      userId: null,
      earliestStartTime: p.earliestStartTime ?? null,
      latestEndTime: p.latestEndTime ?? null,
    }
  }
  if (p.phoneUser) {
    return {
      name: p.name ?? '',
      displayName: p.phoneUser.displayName ?? 'Phone user',
      kind: 'phone' as const,
      userId: null,
      earliestStartTime: p.earliestStartTime ?? null,
      latestEndTime: p.latestEndTime ?? null,
    }
  }
  return {
    name: p.name ?? '',
    displayName: 'Unknown',
    kind: 'unknown' as const,
    userId: null,
    earliestStartTime: p.earliestStartTime ?? null,
    latestEndTime: p.latestEndTime ?? null,
  }
}

async function listConferenceRecords(accessToken: string) {
  const params = new URLSearchParams({ pageSize: '50' })
  const response = await fetch(`${MEET_API}/conferenceRecords?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data: ConferenceRecordsResponse = await response.json()

  if (!response.ok) {
    const message = data.error?.message ?? `Meet API error (${response.status})`
    if (
      response.status === 403 ||
      data.error?.status === 'PERMISSION_DENIED' ||
      /scope|insufficient|permission/i.test(message)
    ) {
      return {
        error:
          'Meet access not granted. Sign out and sign in again to grant Meet attendance permission.' as const,
      }
    }
    return { error: message }
  }

  return { records: data.conferenceRecords ?? [] }
}

async function getConferenceRecord(accessToken: string, name: string) {
  const response = await fetch(`${MEET_API}/${name}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data: ConferenceRecord & GoogleApiError = await response.json()

  if (!response.ok) {
    return {
      error:
        data.error?.message ?? `Meet conference API error (${response.status})`,
    }
  }

  return { record: data }
}

async function listParticipants(accessToken: string, parent: string) {
  const params = new URLSearchParams({ pageSize: '100' })
  const response = await fetch(`${MEET_API}/${parent}/participants?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data: ParticipantsResponse = await response.json()

  if (!response.ok) {
    return {
      error:
        data.error?.message ??
        `Meet participants API error (${response.status})`,
    }
  }

  return { participants: data.participants ?? [] }
}

async function listParticipantSessions(accessToken: string, parent: string) {
  const params = new URLSearchParams({ pageSize: '100' })
  const response = await fetch(
    `${MEET_API}/${parent}/participantSessions?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  )
  const data: ParticipantSessionsResponse = await response.json()

  if (!response.ok) {
    return { sessions: [] as MeetParticipantSession[] }
  }

  const sessions: MeetParticipantSession[] = (
    data.participantSessions ?? []
  ).map((s) => {
    const startTime = s.startTime ?? null
    const endTime = s.endTime ?? null
    return {
      name: s.name ?? '',
      startTime,
      endTime,
      durationMs: durationMs(startTime, endTime),
    }
  })

  return { sessions }
}

async function buildParticipant(
  accessToken: string,
  record: ParticipantRecord,
): Promise<MeetAttendanceParticipant> {
  const base = mapParticipantBase(record)
  if (!base.name) {
    return {
      ...base,
      sessionCount: 0,
      totalDurationMs: null,
      sessions: [],
    }
  }

  const { sessions } = await listParticipantSessions(accessToken, base.name)
  const knownDurations = sessions
    .map((s) => s.durationMs)
    .filter((ms): ms is number => ms !== null)
  const totalDurationMs =
    knownDurations.length > 0
      ? knownDurations.reduce((sum, ms) => sum + ms, 0)
      : durationMs(base.earliestStartTime, base.latestEndTime)

  return {
    ...base,
    sessionCount: sessions.length,
    totalDurationMs,
    sessions,
  }
}

async function toSummary(
  accessToken: string,
  record: ConferenceRecord,
): Promise<MeetConferenceSummary | null> {
  if (!record.name) return null

  const participantsResult = await listParticipants(accessToken, record.name)
  const participantCount =
    'error' in participantsResult
      ? 0
      : participantsResult.participants.length

  return {
    id: conferenceRecordId(record.name),
    name: record.name,
    startTime: record.startTime ?? null,
    endTime: record.endTime ?? null,
    space: record.space ?? null,
    participantCount,
  }
}

/** Lightweight list for Meetings / History pages. */
export const getMeetConferences = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{
    conferences: MeetConferenceSummary[]
    error?: string
  }> => {
    const headers = getRequestHeaders()
    const tokenResult = await getGoogleAccessToken(headers)
    if ('error' in tokenResult) {
      return { conferences: [], error: tokenResult.error }
    }

    const listResult = await listConferenceRecords(tokenResult.accessToken)
    if ('error' in listResult) {
      return { conferences: [], error: listResult.error }
    }

    const conferences: MeetConferenceSummary[] = []
    for (const record of listResult.records) {
      const summary = await toSummary(tokenResult.accessToken, record)
      if (summary) conferences.push(summary)
    }

    return { conferences }
  },
)

/** Full attendance for one conference (detail page). */
export const getMeetConferenceDetail = createServerFn({ method: 'GET' })
  .validator((data: unknown) => {
    if (!data || typeof data !== 'object') {
      throw new Error('conferenceId is required')
    }
    const conferenceId = (data as { conferenceId?: unknown }).conferenceId
    if (typeof conferenceId !== 'string' || !conferenceId.trim()) {
      throw new Error('conferenceId is required')
    }
    return { conferenceId: conferenceId.trim() }
  })
  .handler(
    async ({
      data,
    }): Promise<{
      conference: MeetAttendanceConference | null
      error?: string
    }> => {
      const headers = getRequestHeaders()
      const tokenResult = await getGoogleAccessToken(headers)
      if ('error' in tokenResult) {
        return { conference: null, error: tokenResult.error }
      }

      const name = conferenceRecordName(data.conferenceId)
      const recordResult = await getConferenceRecord(
        tokenResult.accessToken,
        name,
      )
      if ('error' in recordResult) {
        return { conference: null, error: recordResult.error }
      }

      const record = recordResult.record
      if (!record.name) {
        return { conference: null, error: 'Conference not found' }
      }

      const participantsResult = await listParticipants(
        tokenResult.accessToken,
        record.name,
      )
      const rawParticipants =
        'error' in participantsResult ? [] : participantsResult.participants

      const participants = await Promise.all(
        rawParticipants.map((p) =>
          buildParticipant(tokenResult.accessToken, p),
        ),
      )

      return {
        conference: {
          id: conferenceRecordId(record.name),
          name: record.name,
          startTime: record.startTime ?? null,
          endTime: record.endTime ?? null,
          space: record.space ?? null,
          participantCount: participants.length,
          participants,
        },
      }
    },
  )
