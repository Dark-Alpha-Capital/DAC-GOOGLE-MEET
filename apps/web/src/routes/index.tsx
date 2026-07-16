import { createFileRoute, Link, redirect } from '@tanstack/react-router'

import { authClient } from '#/lib/auth-client'
import {
  getStoredMeetings,
  syncMeetingsFromCalendar,
  type MeetingWithParticipants,
} from '#/lib/calendar'
import { getSession } from '#/lib/session'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const session = await getSession()
    if (!session) {
      throw redirect({ to: '/login' })
    }
    return { session }
  },
  loader: async () => {
    const sync = await syncMeetingsFromCalendar()
    const stored = await getStoredMeetings()
    return {
      meetings: stored.meetings,
      recent: stored.recent,
      error: sync.error ?? stored.error,
      synced: sync.synced,
      removed: sync.removed ?? 0,
    }
  },
  component: HomePage,
})

function formatWhen(value: Date | string | null | undefined) {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function botStatusLabel(run: MeetingWithParticipants['latestBotRun']) {
  if (!run) return 'bot: not started'
  switch (run.status) {
    case 'pending':
      return 'bot: pending'
    case 'joining':
      return 'bot: joining…'
    case 'waiting_admission':
      return 'bot: waiting to be admitted'
    case 'joined':
      return 'bot: in call / recording'
    case 'left':
      return run.transcriptKey || run.transcriptText
        ? 'bot: completed · transcript ready'
        : run.recordingKey
          ? 'bot: completed · audio saved'
          : 'bot: completed · no audio'
    case 'failed':
      return `bot: failed${run.errorMessage ? ` · ${run.errorMessage}` : ''}`
    default:
      return `bot: ${run.status}`
  }
}

function MeetingRow({ item }: { item: MeetingWithParticipants }) {
  const run = item.latestBotRun
  return (
    <li className="py-4">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <Link
          to="/meeting/$meetingId"
          params={{ meetingId: item.id }}
          className="font-medium text-[var(--sea-ink)] hover:underline"
        >
          {item.title}
        </Link>
        <span className="text-sm text-[var(--sea-ink-soft)]">
          {formatWhen(item.startsAt)}
        </span>
      </div>

      {item.meetLink ? (
        <a
          href={item.meetLink}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-sm text-[var(--lagoon-deep)]"
        >
          {item.meetLink}
        </a>
      ) : null}

      <p className="mt-2 text-sm font-medium text-[var(--sea-ink)]">
        {botStatusLabel(run)}
      </p>
      {run ? (
        <p className="mt-1 font-mono text-xs text-[var(--sea-ink-soft)]">
          meeting={item.status}
          {run.joinedAt ? ` · joined ${formatWhen(run.joinedAt)}` : ''}
          {run.leftAt ? ` · left ${formatWhen(run.leftAt)}` : ''}
          {run.recordingKey ? ` · audio saved` : ''}
          {run.transcriptText ? ` · transcript ready` : ''}
        </p>
      ) : null}

      <p className="mt-1 font-mono text-xs text-[var(--sea-ink-soft)]">
        workflow: {item.workflowStatus ?? 'none'}
        {item.botWakeAt ? ` · bot wakes ${formatWhen(item.botWakeAt)}` : ''}
        {item.workflowError ? ` · error=${item.workflowError}` : ''}
      </p>

      <Link
        to="/meeting/$meetingId"
        params={{ meetingId: item.id }}
        className="mt-2 inline-block text-xs font-semibold text-[var(--lagoon-deep)]"
      >
        Open meeting →
      </Link>

      {item.participants.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm text-[var(--sea-ink-soft)]">
          {item.participants.map((p) => (
            <li key={`${item.id}-${p.email}`}>
              {p.displayName ?? p.email}
              {p.responseStatus ? ` · ${p.responseStatus}` : ''}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
          No invitees listed
        </p>
      )}
    </li>
  )
}

function HomePage() {
  const { session } = Route.useRouteContext()
  const { meetings, recent, error, synced, removed } = Route.useLoaderData()

  return (
    <main className="page-wrap px-4 py-12">
      <div className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="display-title text-4xl font-bold tracking-tight text-[var(--sea-ink)] sm:text-5xl">
            dac-google meet
          </h1>
          <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
            Signed in as {session.user.email}
          </p>
          <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
            Synced {synced} Meet event{synced === 1 ? '' : 's'}
            {removed > 0
              ? ` · removed ${removed} deleted from Calendar`
              : ''}{' '}
            from Google Calendar
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            void authClient.signOut({
              fetchOptions: {
                onSuccess: () => {
                  window.location.href = '/login'
                },
              },
            })
          }}
          className="rounded-full border border-[rgba(23,58,64,0.2)] bg-white/50 px-5 py-2.5 text-sm font-semibold text-[var(--sea-ink)] transition hover:border-[rgba(23,58,64,0.35)]"
        >
          Sign out
        </button>
      </div>

      <section className="island-shell rounded-2xl px-5 py-6 sm:px-8">
        <h2 className="text-lg font-semibold text-[var(--sea-ink)]">
          Upcoming Google Meet meetings
        </h2>
        <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
          Bot status updates as the notetaker joins, records, and uploads to
          Nextcloud.
        </p>

        {error ? (
          <p className="mt-4 text-sm text-red-600">{error}</p>
        ) : meetings.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--sea-ink-soft)]">
            No upcoming events with a Google Meet link.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-[var(--line)]">
            {meetings.map((item) => (
              <MeetingRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </section>

      <section className="island-shell mt-8 rounded-2xl px-5 py-6 sm:px-8">
        <h2 className="text-lg font-semibold text-[var(--sea-ink)]">
          Recent bot history
        </h2>
        <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
          Completed and cancelled meetings with join / recording outcome.
        </p>
        {recent.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--sea-ink-soft)]">
            No completed bot runs yet.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-[var(--line)]">
            {recent.map((item) => (
              <MeetingRow key={item.id} item={item} />
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
