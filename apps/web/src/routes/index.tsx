import { useMemo, useState } from 'react'
import {
  createFileRoute,
  Link,
  redirect,
  useRouter,
} from '@tanstack/react-router'

import { Alert, AlertDescription } from '#/components/ui/alert'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
import { Skeleton } from '#/components/ui/skeleton'
import { authClient } from '#/lib/auth-client'
import {
  getStoredMeetings,
  syncMeetingsFromCalendar,
  type MeetingWithParticipants,
} from '#/lib/calendar'
import { requestBotForMeeting } from '#/lib/request-bot'
import { getSession } from '#/lib/session'
import { stopBotForMeeting } from '#/lib/stop-bot'
import {
  addDays,
  formatDayLabel,
  formatWhen,
  isSameLocalDay,
  startOfLocalDay,
} from '#/lib/utils'

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
    <Card>
      <CardHeader className="pb-0">
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-28" />
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-8 w-28" />
      </CardContent>
    </Card>
  )
}

function HomePending() {
  return (
    <main
      className="mx-auto max-w-3xl px-4 py-12"
      aria-busy="true"
      aria-label="Loading meetings"
    >
      <div className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-4 w-52" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-3 w-64" />
      </div>
      <div className="mt-6 space-y-3">
        <MeetingRowSkeleton />
        <MeetingRowSkeleton />
        <MeetingRowSkeleton />
      </div>
    </main>
  )
}

const ACTIVE_WORKFLOW = new Set(['queued', 'running', 'waiting', 'paused'])

function isBotScheduled(item: MeetingWithParticipants) {
  if (!item.workflowInstanceId) return false
  if (!item.workflowStatus || item.workflowStatus === 'missing') return false
  return ACTIVE_WORKFLOW.has(item.workflowStatus)
}

function scheduleBadge(item: MeetingWithParticipants): {
  label: string
  variant: 'default' | 'secondary' | 'destructive' | 'outline'
} {
  const run = item.latestBotRun
  if (run?.status === 'joined' || run?.status === 'joining') {
    return { label: 'Bot in call', variant: 'default' }
  }
  if (run?.status === 'waiting_admission') {
    return { label: 'Waiting admission', variant: 'default' }
  }
  if (run?.status === 'left') {
    return {
      label:
        run.transcriptKey || run.transcriptText
          ? 'Completed · transcript ready'
          : run.recordingKey
            ? 'Completed · audio saved'
            : 'Completed',
      variant: 'secondary',
    }
  }
  if (run?.status === 'failed' || item.workflowStatus === 'errored') {
    return {
      label: `Failed${run?.errorMessage ? ` · ${run.errorMessage}` : ''}`,
      variant: 'destructive',
    }
  }
  if (isBotScheduled(item)) {
    const wake =
      item.botWakeAt && !Number.isNaN(new Date(item.botWakeAt).getTime())
        ? formatWhen(item.botWakeAt)
        : null
    return {
      label: wake ? `Scheduled · joins ~${wake}` : 'Scheduled',
      variant: 'default',
    }
  }
  return { label: 'Not scheduled', variant: 'outline' }
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

function canScheduleBot(item: MeetingWithParticipants) {
  if (!item.meetLink) return false
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
    run?.status === 'joined' ||
    run?.status === 'left'
  ) {
    return false
  }
  return true
}

function MeetingRow({
  index,
  item,
  onScheduleBot,
  onStopBot,
  scheduling,
  stopping,
}: {
  index: number
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

  return (
    <li>
      <Card>
        <CardHeader className="pb-0">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 w-6 shrink-0 text-sm tabular-nums text-muted-foreground">
              {index}.
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
                <CardTitle className="text-base">
                  <Link
                    to="/meeting/$meetingId"
                    params={{ meetingId: item.id }}
                    className="hover:underline"
                  >
                    {item.title}
                  </Link>
                </CardTitle>
                <CardDescription className="shrink-0">
                  {formatWhen(item.startsAt)} – {formatWhen(item.endsAt)}
                </CardDescription>
              </div>
              {item.meetLink ? (
                <a
                  href={item.meetLink}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-block text-sm text-muted-foreground hover:text-foreground hover:underline"
                >
                  Join Meet
                </a>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-3">
          <div className="ml-9 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={badge.variant}>{badge.label}</Badge>
              {item.workflowError ? (
                <span className="text-xs text-destructive">
                  {item.workflowError}
                </span>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {showSchedule ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => onScheduleBot(item.id)}
                >
                  {scheduling ? 'Scheduling…' : 'Schedule bot'}
                </Button>
              ) : null}
              {showStop ? (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() => onStopBot(item.id)}
                >
                  {stopping ? 'Stopping…' : 'Stop bot'}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" asChild>
                <Link to="/meeting/$meetingId" params={{ meetingId: item.id }}>
                  Details
                </Link>
              </Button>
            </div>

            {item.participants.length > 0 ? (
              <ul className="space-y-0.5 text-sm text-muted-foreground">
                {item.participants.map((p) => (
                  <li key={`${item.id}-${p.email}`}>
                    {p.displayName ?? p.email}
                    {p.responseStatus ? ` · ${p.responseStatus}` : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No invitees listed</p>
            )}
          </div>
        </CardContent>
      </Card>
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
    <main className="mx-auto max-w-3xl px-4 py-12">
      <div className="mb-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Meetings
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {session.user.email}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Synced {synced} Meet event{synced === 1 ? '' : 's'}
            {removed > 0 ? ` · removed ${removed}` : ''} from Calendar
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            void authClient.signOut({
              fetchOptions: {
                onSuccess: () => {
                  window.location.href = '/login'
                },
              },
            })
          }}
        >
          Sign out
        </Button>
      </div>

      <section>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-medium">{formatDayLabel(selectedDay)}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {selectedDay.toLocaleDateString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
              {' · '}
              Schedule the bot manually when you want notes.
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDayOffset((n) => n - 1)}
              aria-label="Previous day"
            >
              ←
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDayOffset(0)}>
              Today
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDayOffset((n) => n + 1)}
              aria-label="Next day"
            >
              →
            </Button>
          </div>
        </div>

        {error || actionError ? (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>{actionError ?? error}</AlertDescription>
          </Alert>
        ) : null}

        {dayMeetings.length === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">
            No Google Meet events on this day.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {dayMeetings.map((item, i) => (
              <MeetingRow
                key={item.id}
                index={i + 1}
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

      <section className="mt-10">
        <h2 className="text-lg font-medium">Recent bot history</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Completed and cancelled meetings with join / recording outcome.
        </p>
        {recent.length === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">
            No completed bot runs yet.
          </p>
        ) : (
          <ul className="mt-4 space-y-3">
            {recent.map((item, i) => (
              <MeetingRow
                key={item.id}
                index={i + 1}
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
