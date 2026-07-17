import { useMemo, useState } from 'react'
import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router'

import { Skeleton } from '#/components/ui/skeleton'
import { authClient } from '#/lib/auth-client'
import {
  getStoredMeetings,
  syncMeetingsFromCalendar,
  type MeetingWithParticipants,
} from '#/lib/calendar'
import { requestBotForMeeting } from '#/lib/request-bot'
import { stopBotForMeeting } from '#/lib/stop-bot'
import { getSession } from '#/lib/session'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const session = await getSession()
    if (!session) {
      throw redirect({ to: '/login' })
    }
    return { session }
  },
  pendingComponent: HomePending,
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

function MeetingRowSkeleton() {
  return (
    <li className="py-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-4 w-28" />
      </div>
      <Skeleton className="mt-2 h-4 w-20" />
      <Skeleton className="mt-3 h-4 w-56" />
      <div className="mt-3 flex gap-3">
        <Skeleton className="h-7 w-20 rounded-full" />
        <Skeleton className="h-4 w-24 self-center" />
      </div>
      <div className="mt-3 space-y-1.5">
        <Skeleton className="h-3.5 w-36" />
        <Skeleton className="h-3.5 w-28" />
      </div>
    </li>
  )
}

function HomePending() {
  return (
    <main className="page-wrap px-4 py-12" aria-busy="true" aria-label="Loading meetings">
      <div className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-12 w-64 sm:h-14 sm:w-80" />
          <Skeleton className="h-4 w-52" />
          <Skeleton className="h-3 w-72" />
        </div>
        <Skeleton className="h-10 w-24 rounded-full" />
      </div>

      <section className="island-shell rounded-2xl px-5 py-6 sm:px-8">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-2">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-10 rounded-full" />
            <Skeleton className="h-8 w-16 rounded-full" />
            <Skeleton className="h-8 w-10 rounded-full" />
          </div>
        </div>
        <ul className="mt-4 divide-y divide-[var(--line)]">
          <MeetingRowSkeleton />
          <MeetingRowSkeleton />
          <MeetingRowSkeleton />
        </ul>
      </section>

      <section className="island-shell mt-8 rounded-2xl px-5 py-6 sm:px-8">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="mt-2 h-3 w-72 max-w-full" />
        <ul className="mt-4 divide-y divide-[var(--line)]">
          <MeetingRowSkeleton />
          <MeetingRowSkeleton />
        </ul>
      </section>
    </main>
  )
}

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

const ACTIVE_WORKFLOW = new Set([
  'queued',
  'running',
  'waiting',
  'paused',
])

function isBotScheduled(item: MeetingWithParticipants) {
  if (!item.workflowInstanceId) return false
  if (!item.workflowStatus || item.workflowStatus === 'missing') return false
  return ACTIVE_WORKFLOW.has(item.workflowStatus)
}

function scheduleBadge(item: MeetingWithParticipants) {
  const run = item.latestBotRun
  if (run?.status === 'joined' || run?.status === 'joining') {
    return { label: 'Bot in call', tone: 'active' as const }
  }
  if (run?.status === 'waiting_admission') {
    return { label: 'Waiting admission', tone: 'active' as const }
  }
  if (run?.status === 'left') {
    return {
      label:
        run.transcriptKey || run.transcriptText
          ? 'Completed · transcript ready'
          : run.recordingKey
            ? 'Completed · audio saved'
            : 'Completed',
      tone: 'done' as const,
    }
  }
  if (run?.status === 'failed' || item.workflowStatus === 'errored') {
    return {
      label: `Failed${run?.errorMessage ? ` · ${run.errorMessage}` : ''}`,
      tone: 'failed' as const,
    }
  }
  if (isBotScheduled(item)) {
    const wake =
      item.botWakeAt && !Number.isNaN(new Date(item.botWakeAt).getTime())
        ? formatWhen(item.botWakeAt)
        : null
    return {
      label: wake ? `Scheduled · joins ~${wake}` : 'Scheduled',
      tone: 'scheduled' as const,
    }
  }
  return { label: 'Not scheduled', tone: 'idle' as const }
}

function canStopBot(item: MeetingWithParticipants) {
  if (isBotScheduled(item)) return true
  const run = item.latestBotRun
  return (
    run?.status === 'pending' ||
    run?.status === 'joining' ||
    run?.status === 'waiting_admission' ||
    run?.status === 'joined'
  )
}

/** Manual schedule is allowed when the meeting can still get a bot workflow. */
function canScheduleBot(item: MeetingWithParticipants) {
  if (!item.meetLink) return false
  // Ongoing / recently-ended calendar events may still be joinable.
  const endsAt = new Date(item.endsAt).getTime()
  const graceMs = 4 * 60 * 60 * 1000
  const joinableWindow =
    item.status === 'scheduled' ||
    (item.status === 'completed' && Date.now() < endsAt + graceMs)
  if (!joinableWindow) return false
  if (isBotScheduled(item)) return false
  const run = item.latestBotRun
  if (
    run?.status === 'joining' ||
    run?.status === 'waiting_admission' ||
    run?.status === 'joined'
  ) {
    return false
  }
  if (run?.status === 'left') return false
  return true
}

function MeetingRow({
  item,
  onScheduleBot,
  onStopBot,
  scheduling,
  stopping,
}: {
  item: MeetingWithParticipants
  onScheduleBot: (meetingId: string) => void
  onStopBot: (meetingId: string) => void
  scheduling: boolean
  stopping: boolean
}) {
  const badge = scheduleBadge(item)
  const showSchedule = canScheduleBot(item)
  const showStop = canStopBot(item)
  const busy = scheduling || stopping

  const badgeClass =
    badge.tone === 'scheduled'
      ? 'bg-[var(--lagoon-deep)]/15 text-[var(--lagoon-deep)]'
      : badge.tone === 'active'
        ? 'bg-[var(--lagoon-deep)] text-white'
        : badge.tone === 'failed'
          ? 'bg-red-100 text-red-700'
          : badge.tone === 'done'
            ? 'bg-black/10 text-[var(--sea-ink)]'
            : 'bg-black/5 text-[var(--sea-ink-soft)]'

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

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${badgeClass}`}
        >
          {badge.label}
        </span>
        {item.workflowError ? (
          <span className="text-xs text-red-600">{item.workflowError}</span>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {showSchedule ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onScheduleBot(item.id)}
            className="rounded-full bg-[var(--lagoon-deep)] px-4 py-1.5 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {scheduling ? 'Scheduling…' : 'Schedule bot'}
          </button>
        ) : null}
        {showStop ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onStopBot(item.id)}
            className="rounded-full border border-red-300 bg-red-50 px-4 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-50"
          >
            {stopping ? 'Stopping…' : 'Stop bot'}
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
  const [schedulingId, setSchedulingId] = useState<string | null>(null)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const selectedDay = useMemo(
    () => addDays(startOfLocalDay(new Date()), dayOffset),
    [dayOffset],
  )

  const dayMeetings = useMemo(
    () => meetings.filter((m) => isSameLocalDay(m.startsAt, selectedDay)),
    [meetings, selectedDay],
  )

  async function handleScheduleBot(meetingId: string) {
    setActionError(null)
    setSchedulingId(meetingId)
    try {
      const result = await requestBotForMeeting({ data: { meetingId } })
      if (!result.ok) {
        setActionError(result.error ?? 'Failed to schedule bot')
        return
      }
      await router.invalidate()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setSchedulingId(null)
    }
  }

  async function handleStopBot(meetingId: string) {
    setActionError(null)
    setStoppingId(meetingId)
    try {
      const result = await stopBotForMeeting({ data: { meetingId } })
      if (!result.ok) {
        setActionError(result.error ?? 'Failed to stop bot')
        return
      }
      await router.invalidate()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setStoppingId(null)
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
              Schedule the bot manually for meetings you want notes for.
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
                scheduling={schedulingId === item.id}
                stopping={stoppingId === item.id}
                onScheduleBot={handleScheduleBot}
                onStopBot={handleStopBot}
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
                scheduling={false}
                stopping={false}
                onScheduleBot={handleScheduleBot}
                onStopBot={handleStopBot}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
