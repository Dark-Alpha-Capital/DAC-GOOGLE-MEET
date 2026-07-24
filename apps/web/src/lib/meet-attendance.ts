import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'

import { getAuth } from '#/lib/auth'

const MEET_SCOPE = 'https://www.googleapis.com/auth/meetings.space.readonly'
const MEET_API = 'https://meet.googleapis.com/v2'

export type MeetParticipantKind = 'signedin' | 'anonymous' | 'phone' | 'unknown'

export type MeetAttendanceParticipant = {
  name: string
  displayName: string
  kind: MeetParticipantKind
  userId: string | null
  earliestStartTime: string | null
  latestEndTime: string | null
}

export type MeetAttendanceConference = {
  name: string
  startTime: string | null
  endTime: string | null
  space: string | null
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
  nextPageToken?: string
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
  nextPageToken?: string
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

function mapParticipant(p: ParticipantRecord): MeetAttendanceParticipant {
  if (p.signedinUser) {
    return {
      name: p.name ?? '',
      displayName: p.signedinUser.displayName ?? 'Unknown',
      kind: 'signedin',
      userId: p.signedinUser.user ?? null,
      earliestStartTime: p.earliestStartTime ?? null,
      latestEndTime: p.latestEndTime ?? null,
    }
  }
  if (p.anonymousUser) {
    return {
      name: p.name ?? '',
      displayName: p.anonymousUser.displayName ?? 'Anonymous',
      kind: 'anonymous',
      userId: null,
      earliestStartTime: p.earliestStartTime ?? null,
      latestEndTime: p.latestEndTime ?? null,
    }
  }
  if (p.phoneUser) {
    return {
      name: p.name ?? '',
      displayName: p.phoneUser.displayName ?? 'Phone user',
      kind: 'phone',
      userId: null,
      earliestStartTime: p.earliestStartTime ?? null,
      latestEndTime: p.latestEndTime ?? null,
    }
  }
  return {
    name: p.name ?? '',
    displayName: 'Unknown',
    kind: 'unknown',
    userId: null,
    earliestStartTime: p.earliestStartTime ?? null,
    latestEndTime: p.latestEndTime ?? null,
  }
}

async function listConferenceRecords(accessToken: string) {
  const params = new URLSearchParams({ pageSize: '20' })
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

async function listParticipants(accessToken: string, parent: string) {
  const params = new URLSearchParams({ pageSize: '100' })
  const response = await fetch(
    `${MEET_API}/${parent}/participants?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  )
  const data: ParticipantsResponse = await response.json()

  if (!response.ok) {
    return {
      error:
        data.error?.message ??
        `Meet participants API error (${response.status})`,
    }
  }

  return { participants: (data.participants ?? []).map(mapParticipant) }
}

export const getMeetAttendance = createServerFn({ method: 'GET' }).handler(
  async (): Promise<{
    conferences: MeetAttendanceConference[]
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

    const conferences: MeetAttendanceConference[] = []
    for (const record of listResult.records) {
      if (!record.name) continue

      const participantsResult = await listParticipants(
        tokenResult.accessToken,
        record.name,
      )
      const participants =
        'error' in participantsResult ? [] : participantsResult.participants

      conferences.push({
        name: record.name,
        startTime: record.startTime ?? null,
        endTime: record.endTime ?? null,
        space: record.space ?? null,
        participants,
      })
    }

    return { conferences }
  },
)
