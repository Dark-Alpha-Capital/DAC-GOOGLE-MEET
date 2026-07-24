import { Link } from '@tanstack/react-router'

import { Badge } from '#/components/ui/badge'
import type { MeetConferenceSummary } from '#/lib/meet-attendance'

function formatTime(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

export function ConferencesList({
  conferences,
  emptyMessage,
}: {
  conferences: MeetConferenceSummary[]
  emptyMessage: string
}) {
  if (conferences.length === 0) {
    return (
      <p className="border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
        {emptyMessage}
      </p>
    )
  }

  return (
    <ul className="divide-y divide-border border border-border">
      {conferences.map((conference) => (
        <li key={conference.id}>
          <Link
            to="/attendance/$conferenceId"
            params={{ conferenceId: conference.id }}
            className="flex flex-col gap-2 px-4 py-4 no-underline transition-colors hover:bg-muted/40 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {conference.space ?? conference.name}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatTime(conference.startTime)}
                {' → '}
                {conference.endTime
                  ? formatTime(conference.endTime)
                  : 'in progress'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge variant="secondary">
                {conference.participantCount} participant
                {conference.participantCount === 1 ? '' : 's'}
              </Badge>
              <span className="text-xs text-muted-foreground">
                View attendance →
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}
