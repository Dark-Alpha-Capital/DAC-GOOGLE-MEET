import { useMemo, useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { CalendarIcon, Search, X } from 'lucide-react'

import {
  getMeetingBotCategory,
  MeetingsDataTable,
  type MeetingBotCategory,
} from '#/components/meetings-data-table'
import { Alert, AlertDescription } from '#/components/ui/alert'
import { Button } from '#/components/ui/button'
import { Calendar } from '#/components/ui/calendar'
import { Input } from '#/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '#/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { Skeleton } from '#/components/ui/skeleton'
import {
  getStoredMeetings,
  syncMeetingsFromCalendar,
  type MeetingWithParticipants,
} from '#/lib/calendar'
import { requestBotForMeeting } from '#/lib/request-bot'
import { stopBotForMeeting } from '#/lib/stop-bot'
import {
  addDays,
  formatDayLabel,
  isSameLocalDay,
  startOfLocalDay,
} from '#/lib/utils'

/** Matches the window loaded by `getStoredMeetings`. */
const MEETING_WINDOW_PAST_DAYS = 7
const MEETING_WINDOW_FUTURE_DAYS = 21

type BotStatusFilter = 'all' | MeetingBotCategory

const BOT_STATUS_OPTIONS: Array<{ value: BotStatusFilter; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'not_scheduled', label: 'Not scheduled' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'in_call', label: 'Bot in call' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
]

export const Route = createFileRoute('/_app/')({
  pendingComponent: HomePending,
  loader: async () => {
    let sync: { synced: number; removed: number; error?: string } = {
      synced: 0,
      removed: 0,
    }
    let stored: {
      meetings: Awaited<ReturnType<typeof getStoredMeetings>>['meetings']
      error?: string
    } = { meetings: [] }

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
      stored = { meetings: [], error: message }
    }

    return {
      meetings: stored.meetings,
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

function matchesSearch(item: MeetingWithParticipants, query: string) {
  if (!query) return true
  const haystack = [
    item.title,
    ...item.participants.flatMap((p) => [p.email, p.displayName ?? '']),
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(query)
}

function HomePage() {
  const router = useRouter()
  const { session } = Route.useRouteContext()
  const { meetings, error, synced, removed } = Route.useLoaderData()
  const [selectedDay, setSelectedDay] = useState(() =>
    startOfLocalDay(new Date()),
  )
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [botStatus, setBotStatus] = useState<BotStatusFilter>('all')
  const [schedulingId, setSchedulingId] = useState<string | null>(null)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const today = useMemo(() => startOfLocalDay(new Date()), [])
  const windowStart = useMemo(
    () => addDays(today, -MEETING_WINDOW_PAST_DAYS),
    [today],
  )
  const windowEnd = useMemo(
    () => addDays(today, MEETING_WINDOW_FUTURE_DAYS),
    [today],
  )

  const normalizedQuery = searchQuery.trim().toLowerCase()
  const filtersActive = normalizedQuery.length > 0 || botStatus !== 'all'

  const daysWithMeetings = useMemo(
    () => meetings.map((m) => startOfLocalDay(new Date(m.startsAt))),
    [meetings],
  )

  const dayMeetings = useMemo(() => {
    return meetings.filter((m) => {
      if (!isSameLocalDay(m.startsAt, selectedDay)) return false
      if (!matchesSearch(m, normalizedQuery)) return false
      if (botStatus !== 'all' && getMeetingBotCategory(m) !== botStatus) {
        return false
      }
      return true
    })
  }, [meetings, selectedDay, normalizedQuery, botStatus])

  const dayMeetingCount = useMemo(
    () => meetings.filter((m) => isSameLocalDay(m.startsAt, selectedDay)).length,
    [meetings, selectedDay],
  )

  function clearFilters() {
    setSearchQuery('')
    setBotStatus('all')
  }

  function selectDay(date: Date) {
    const next = startOfLocalDay(date)
    if (next < windowStart || next > windowEnd) return
    setSelectedDay(next)
  }

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

  const emptyMessage =
    dayMeetingCount === 0
      ? 'No Google Meet events on this day.'
      : filtersActive
        ? 'No meetings match the current filters.'
        : 'No Google Meet events on this day.'

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
              onClick={() => selectDay(addDays(selectedDay, -1))}
              disabled={selectedDay <= windowStart}
              aria-label="Previous day"
            >
              ←
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => selectDay(today)}
              disabled={isSameLocalDay(selectedDay, today)}
            >
              Today
            </Button>
            <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
              <PopoverTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="Pick a date"
                  className="gap-1.5"
                >
                  <CalendarIcon className="size-3.5" />
                  <span className="hidden sm:inline">Calendar</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  mode="single"
                  selected={selectedDay}
                  onSelect={(date) => {
                    if (!date) return
                    selectDay(date)
                    setCalendarOpen(false)
                  }}
                  defaultMonth={selectedDay}
                  disabled={{ before: windowStart, after: windowEnd }}
                  modifiers={{ hasMeeting: daysWithMeetings }}
                  modifiersClassNames={{
                    hasMeeting:
                      'relative after:absolute after:bottom-1 after:left-1/2 after:size-1 after:-translate-x-1/2 after:rounded-full after:bg-primary',
                  }}
                />
              </PopoverContent>
            </Popover>
            <Button
              size="sm"
              variant="outline"
              onClick={() => selectDay(addDays(selectedDay, 1))}
              disabled={selectedDay >= windowEnd}
              aria-label="Next day"
            >
              →
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search title or invitee…"
              className="pl-9"
              aria-label="Search meetings"
            />
          </div>
          <Select
            value={botStatus}
            onValueChange={(value) => setBotStatus(value as BotStatusFilter)}
          >
            <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Bot status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              {BOT_STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filtersActive ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={clearFilters}
              className="gap-1.5 self-start sm:self-auto"
            >
              <X className="size-3.5" />
              Clear
            </Button>
          ) : null}
        </div>

        {filtersActive || dayMeetingCount > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Showing {dayMeetings.length}
            {filtersActive ? ` of ${dayMeetingCount}` : ''} meeting
            {dayMeetings.length === 1 ? '' : 's'}
          </p>
        ) : null}

        {error || actionError ? (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>{actionError ?? error}</AlertDescription>
          </Alert>
        ) : null}

        <MeetingsDataTable
          data={dayMeetings}
          emptyMessage={emptyMessage}
          schedulingId={schedulingId}
          stoppingId={stoppingId}
          onScheduleBot={handleScheduleBot}
          onStopBot={handleStopBot}
        />
      </section>
    </main>
  )
}
