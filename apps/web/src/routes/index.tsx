import { useMemo, useState } from 'react'
import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router'

import { authClient } from '#/lib/auth-client'
import {
  getStoredMeetings,
  syncMeetingsFromCalendar,
  type MeetingWithParticipants,
} from '#/lib/calendar'
import { requestBotForMeeting } from '#/lib/request-bot'
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
    let sync: { synced: number; removed: number; error?: string } = {
      synced: 0,
      removed: 0,
    }
    let stored: {
      meetings: MeetingWithParticipants[]
      recent: MeetingWithParticipants[]
      error?: string
    } = { meetings: [], recent: [] }

    try {
      sync = await syncMeetingsFromCalendar()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[home] calendar sync failed:', message)
      sync = { synced: 0, removed: 0, error: message }
    }

    try {
      stored = await getStoredMeetings()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[home] getStoredMeetings failed:', message)
      stored = { meetings: [], recent: [], error: message }
    }

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

function startOfLocalDay(date: Date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

function addDays(date: Date, days: number) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function isSameLocalDay(a: Date | string, b: Date) {
  const left = a instanceof Date ? a : new Date(a)
  if (Number.isNaN(left.getTime())) return false
  return (
    left.getFullYear() === b.getFullYear() &&
    left.getMonth() === b.getMonth() &&
    left.getDate() === b.getDate()
  )
}

function formatDayLabel(date: Date) {
  const today = startOfLocalDay(new Date())
  const tomorrow = addDays(today, 1)
  const yesterday = addDays(today, -1)
  const day = startOfLocalDay(date)

  if (day.getTime() === today.getTime()) return 'Today'
  if (day.getTime() === tomorrow.getTime()) return 'Tomorrow'
  if (day.getTime() === yesterday.getTime()) return 'Yesterday'

  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

function formatWhen(value: Date | string | null | undefined) {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, {
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

function canRequestBot(item: MeetingWithParticipants) {
  if (!item.meetLink) return false
  if (item.status !== 'scheduled') return false
  const run = item.latestBotRun
  if (!run) return true
  if (run.status === 'left' || run.status === 'failed') return true
  if (
    run.status === 'pending' ||
    run.status === 'joining' ||
    run.status === 'waiting_admission' ||
    run.status === 'joined'
  ) {
    return false
  }
  return true
}

function MeetingRow({
  item,
  onRequestBot,
  requesting,
}: {
  item: MeetingWithParticipants
  onRequestBot: (meetingId: string) => void
  requesting: boolean
}) {
  const run = item.latestBotRun
  const showSend = canRequestBot(item)

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
          {formatWhen(item.startsAt)} – {formatWhen(item.endsAt)}
        </span>
      </div>

      {item.meetLink ? (
        <a
          href={item.meetLink}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-block text-sm text-[var(--lagoon-deep)]"
        >
          Join Meet
        </a>
      ) : null}

      <p className="mt-2 text-sm font-medium text-[var(--sea-ink)]">
        {botStatusLabel(run)}
        {item.workflowStatus ? ` · workflow ${item.workflowStatus}` : ''}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {showSend ? (
          <button
            type="button"
            disabled={requesting}
            onClick={() => onRequestBot(item.id)}
            className="rounded-full bg-[var(--lagoon-deep)] px-4 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {requesting ? 'Sending…' : 'Send bot'}
          </button>
        ) : null}
        <Link
          to="/meeting/$meetingId"
          params={{ meetingId: item.id }}
          className="text-xs font-semibold text-[var(--lagoon-deep)]"
        >
          Open details →
        </Link>
      </div>

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
  const router = useRouter()
  const { session } = Route.useRouteContext()
  const { meetings, recent, error, synced, removed } = Route.useLoaderData()
  const [dayOffset, setDayOffset] = useState(0)
  const [requestingId, setRequestingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const selectedDay = useMemo(
    () => addDays(startOfLocalDay(new Date()), dayOffset),
    [dayOffset],
  )

  const dayMeetings = useMemo(
    () => meetings.filter((m) => isSameLocalDay(m.startsAt, selectedDay)),
    [meetings, selectedDay],
  )

  async function handleRequestBot(meetingId: string) {
    setActionError(null)
    setRequestingId(meetingId)
    try {
      const result = await requestBotForMeeting({ data: { meetingId } })
      if (!result.ok) {
        setActionError(result.error ?? 'Failed to send bot')
        return
      }
      await router.invalidate()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setRequestingId(null)
    }
  }

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
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[var(--sea-ink)]">
              {formatDayLabel(selectedDay)}
            </h2>
            <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
              {selectedDay.toLocaleDateString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
              {' · '}
              Send the bot manually when you want notes for a meeting.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDayOffset((n) => n - 1)}
              className="rounded-full border border-[rgba(23,58,64,0.2)] bg-white/70 px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)]"
              aria-label="Previous day"
            >
              ←
            </button>
            <button
              type="button"
              onClick={() => setDayOffset(0)}
              className="rounded-full border border-[rgba(23,58,64,0.2)] bg-white/70 px-3 py-1.5 text-xs font-semibold text-[var(--sea-ink)]"
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => setDayOffset((n) => n + 1)}
              className="rounded-full border border-[rgba(23,58,64,0.2)] bg-white/70 px-3 py-1.5 text-sm font-semibold text-[var(--sea-ink)]"
              aria-label="Next day"
            >
              →
            </button>
          </div>
        </div>

        {error || actionError ? (
          <p className="mt-4 text-sm text-red-600">{actionError ?? error}</p>
        ) : null}

        {dayMeetings.length === 0 ? (
          <p className="mt-4 text-sm text-[var(--sea-ink-soft)]">
            No Google Meet events on this day.
          </p>
        ) : (
          <ul className="mt-4 divide-y divide-[var(--line)]">
            {dayMeetings.map((item) => (
              <MeetingRow
                key={item.id}
                item={item}
                requesting={requestingId === item.id}
                onRequestBot={handleRequestBot}
              />
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
              <MeetingRow
                key={item.id}
                item={item}
                requesting={false}
                onRequestBot={handleRequestBot}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
