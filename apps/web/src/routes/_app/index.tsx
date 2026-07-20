import { useMemo, useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'

import { MeetingsDataTable } from '#/components/meetings-data-table'
import { Alert, AlertDescription } from '#/components/ui/alert'
import { Button } from '#/components/ui/button'
import { Skeleton } from '#/components/ui/skeleton'
import {
  getStoredMeetings,
  syncMeetingsFromCalendar,
} from '#/lib/calendar'
import { requestBotForMeeting } from '#/lib/request-bot'
import { stopBotForMeeting } from '#/lib/stop-bot'
import {
  addDays,
  formatDayLabel,
  isSameLocalDay,
  startOfLocalDay,
} from '#/lib/utils'

export const Route = createFileRoute('/_app/')({
  pendingComponent: HomePending,
  loader: async () => {
    let sync: { synced: number; removed: number; error?: string } = {
      synced: 0,
      removed: 0,
    }
    let stored: {
      meetings: Awaited<ReturnType<typeof getStoredMeetings>>['meetings']
      recent: Awaited<ReturnType<typeof getStoredMeetings>>['recent']
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

function HomePending() {
  return (
    <main
      className="mx-auto max-w-7xl px-4 py-12 sm:px-6"
      aria-busy="true"
      aria-label="Loading meetings"
    >
      <div className="mb-10 space-y-2">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-4 w-52" />
      </div>
      <Skeleton className="h-64 w-full" />
    </main>
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
    <main className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
      <div className="mb-10">
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

        <MeetingsDataTable
          data={dayMeetings}
          emptyMessage="No Google Meet events on this day."
          schedulingId={schedulingId}
          stoppingId={stoppingId}
          onScheduleBot={handleScheduleBot}
          onStopBot={handleStopBot}
        />
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-medium">Recent bot history</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Completed and cancelled meetings with join / recording outcome.
        </p>
        <MeetingsDataTable
          data={recent}
          emptyMessage="No completed bot runs yet."
          showActions={false}
        />
      </section>
    </main>
  )
}
