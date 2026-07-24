import { createFileRoute, Link } from '@tanstack/react-router'

import { Alert, AlertDescription } from '#/components/ui/alert'
import { Badge } from '#/components/ui/badge'
import { Skeleton } from '#/components/ui/skeleton'
import { getMeetAttendance } from '#/lib/meet-attendance'
import type {
  MeetAttendanceConference,
  MeetParticipantKind,
} from '#/lib/meet-attendance'

export const Route = createFileRoute('/_app/attendance')({
  pendingComponent: AttendancePending,
  loader: async () => {
    try {
      return await getMeetAttendance()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[attendance] getMeetAttendance failed:', message)
      return { conferences: [], error: message }
    }
  },
  component: AttendancePage,
})

function AttendancePending() {
  return (
    <main
      className="mx-auto max-w-7xl px-4 py-12 sm:px-6"
      aria-busy="true"
      aria-label="Loading Meet attendance"
    >
      <div className="mb-10 space-y-2">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
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

function ConferenceBlock({
  conference,
}: {
  conference: MeetAttendanceConference
}) {
  return (
    <section className="border border-border">
      <div className="border-b border-border bg-muted/40 px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">
            {conference.space ?? conference.name}
          </h2>
          <Badge variant="secondary">
            {conference.participants.length} participant
            {conference.participants.length === 1 ? '' : 's'}
          </Badge>
        </div>
        <dl className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
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
          <div className="sm:col-span-2">
            <dt className="inline font-medium text-foreground/80">Record: </dt>
            <dd className="inline break-all font-mono">{conference.name}</dd>
          </div>
        </dl>
      </div>

      {conference.participants.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground sm:px-5">
          No participants found.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {conference.participants.map((participant) => (
            <li
              key={participant.name || participant.displayName}
              className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:px-5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {participant.displayName}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {kindLabel(participant.kind)}
                  {participant.userId ? ` · ${participant.userId}` : ''}
                </p>
              </div>
              <dl className="shrink-0 text-xs text-muted-foreground sm:text-right">
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
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function AttendancePage() {
  const { conferences, error } = Route.useLoaderData()

  return (
    <main className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
      <div className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Meet attendance
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Live participants from Google Meet conference records (~30-day
          retention). Sign in with the account that attended the meetings.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          <Link to="/" className="hover:text-foreground hover:underline">
            ← Back to meetings
          </Link>
        </p>
      </div>

      {error ? (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!error && conferences.length === 0 ? (
        <p className="border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          No recent conference records found (or none within the 30-day
          retention window).
        </p>
      ) : null}

      <div className="space-y-4">
        {conferences.map((conference) => (
          <ConferenceBlock key={conference.name} conference={conference} />
        ))}
      </div>
    </main>
  )
}
