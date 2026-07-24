import { createFileRoute, Link } from '@tanstack/react-router'

import { Alert, AlertDescription } from '#/components/ui/alert'
import { Badge } from '#/components/ui/badge'
import { Skeleton } from '#/components/ui/skeleton'
import { getMeetConferenceDetail } from '#/lib/meet-attendance'
import type {
  MeetAttendanceParticipant,
  MeetParticipantKind,
} from '#/lib/meet-attendance'

export const Route = createFileRoute('/_app/attendance/$conferenceId')({
  pendingComponent: AttendanceDetailPending,
  loader: async ({ params }) => {
    try {
      return await getMeetConferenceDetail({
        data: { conferenceId: params.conferenceId },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[attendance-detail] failed:', message)
      return { conference: null, error: message }
    }
  },
  component: AttendanceDetailPage,
})

function AttendanceDetailPending() {
  return (
    <main
      className="mx-auto max-w-7xl px-4 py-12 sm:px-6"
      aria-busy="true"
      aria-label="Loading attendance"
    >
      <div className="mb-10 space-y-2">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <Skeleton className="h-64 w-full" />
    </main>
  )
}

function formatTime(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function formatDuration(ms: number | null) {
  if (ms === null || Number.isNaN(ms) || ms < 0) return '—'
  const totalSeconds = Math.round(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function kindLabel(kind: MeetParticipantKind) {
  switch (kind) {
    case 'signedin':
      return 'Signed in'
    case 'anonymous':
      return 'Guest'
    case 'phone':
      return 'Phone'
    case 'unknown':
      return 'Unknown'
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

function ParticipantRow({
  participant,
}: {
  participant: MeetAttendanceParticipant
}) {
  const rejoinCount = Math.max(0, participant.sessionCount - 1)

  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">
            {participant.displayName}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {kindLabel(participant.kind)}
            {participant.userId ? ` · ${participant.userId}` : ''}
          </p>
        </div>
        <dl className="shrink-0 space-y-0.5 text-xs text-muted-foreground sm:text-right">
          <div>
            <dt className="inline">Duration: </dt>
            <dd className="inline font-medium text-foreground">
              {formatDuration(participant.totalDurationMs)}
            </dd>
          </div>
          <div>
            <dt className="inline">Sessions: </dt>
            <dd className="inline">
              {participant.sessionCount}
              {rejoinCount > 0 ? ` (${rejoinCount} rejoin)` : ''}
            </dd>
          </div>
          <div>
            <dt className="inline">Joined: </dt>
            <dd className="inline">
              {formatTime(participant.earliestStartTime)}
            </dd>
          </div>
          <div>
            <dt className="inline">Left: </dt>
            <dd className="inline">
              {participant.latestEndTime
                ? formatTime(participant.latestEndTime)
                : 'still in call'}
            </dd>
          </div>
        </dl>
      </div>

      {participant.sessions.length > 1 ? (
        <ul className="mt-2 space-y-1 border-l border-border pl-3 text-xs text-muted-foreground">
          {participant.sessions.map((session, index) => (
            <li key={session.name || `${participant.name}-${index}`}>
              Session {index + 1}: {formatTime(session.startTime)} →{' '}
              {session.endTime ? formatTime(session.endTime) : 'open'} (
              {formatDuration(session.durationMs)})
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}

function AttendanceDetailPage() {
  const { conference, error } = Route.useLoaderData()

  return (
    <main className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
      <div className="mb-10">
        <p className="text-xs text-muted-foreground">
          <Link to="/" className="hover:text-foreground hover:underline">
            ← Back to meetings
          </Link>
        </p>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
          {conference?.space ?? conference?.name ?? 'Attendance'}
        </h1>
        {conference ? (
          <dl className="mt-3 grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
            <div>
              <dt className="inline font-medium text-foreground/80">Start: </dt>
              <dd className="inline">{formatTime(conference.startTime)}</dd>
            </div>
            <div>
              <dt className="inline font-medium text-foreground/80">End: </dt>
              <dd className="inline">
                {conference.endTime
                  ? formatTime(conference.endTime)
                  : 'still active / unknown'}
              </dd>
            </div>
          </dl>
        ) : null}
      </div>

      {error ? (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!error && !conference ? (
        <p className="border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          Conference not found.
        </p>
      ) : null}

      {conference ? (
        <section className="border border-border">
          <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-3 sm:px-5">
            <h2 className="text-sm font-semibold">Participants</h2>
            <Badge variant="secondary">
              {conference.participants.length} participant
              {conference.participants.length === 1 ? '' : 's'}
            </Badge>
          </div>

          {conference.participants.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">
              No participants found.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {conference.participants.map((participant) => (
                <ParticipantRow
                  key={participant.name || participant.displayName}
                  participant={participant}
                />
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </main>
  )
}
