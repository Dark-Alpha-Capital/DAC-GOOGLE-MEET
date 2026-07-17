import { createFileRoute, Link, redirect } from '@tanstack/react-router'

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '#/components/ui/tabs'
import { getMeetingDetail } from '#/lib/meeting-detail'
import { getSession } from '#/lib/session'

export const Route = createFileRoute('/meeting/$meetingId')({
  beforeLoad: async () => {
    const session = await getSession()
    if (!session) {
      throw redirect({ to: '/login' })
    }
    return { session }
  },
  loader: async ({ params }) => {
    const result = await getMeetingDetail({
      data: { meetingId: params.meetingId },
    })
    return result
  },
  component: MeetingDetailPage,
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

function botTimeline(status: string | undefined) {
  const steps = [
    'pending',
    'joining',
    'waiting_admission',
    'joined',
    'left',
  ] as const
  if (!status) {
    return steps.map((s) => ({ id: s, done: false, current: false }))
  }
  if (status === 'failed') {
    return [
      ...steps.slice(0, 3).map((s) => ({ id: s, done: true, current: false })),
      { id: 'failed', done: true, current: true },
    ]
  }
  const idx = steps.indexOf(status as (typeof steps)[number])
  return steps.map((s, i) => ({
    id: s,
    done: idx >= 0 && i <= idx,
    current: s === status,
  }))
}

function formatDuration(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const totalSec = Math.round(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function MeetingDetailPage() {
  const { meeting, error } = Route.useLoaderData()

  if (error || !meeting) {
    return (
      <main className="page-wrap px-4 py-12">
        <Link to="/" className="text-sm text-[var(--lagoon-deep)]">
          ← Back
        </Link>
        <p className="mt-6 text-sm text-red-600">{error ?? 'Not found'}</p>
      </main>
    )
  }

  const run = meeting.botRun
  const notes = meeting.notes
  const timeline = botTimeline(run?.status)

  return (
    <main className="page-wrap px-4 py-12">
      <Link
        to="/"
        className="text-sm font-medium text-[var(--lagoon-deep)] hover:underline"
      >
        ← All meetings
      </Link>

      <header className="mt-6">
        <h1 className="display-title text-3xl font-bold tracking-tight text-[var(--sea-ink)] sm:text-4xl">
          {meeting.title}
        </h1>
        <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
          Calendar: {formatWhen(meeting.startsAt)} – {formatWhen(meeting.endsAt)}
        </p>
        {meeting.meetLink ? (
          <a
            href={meeting.meetLink}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-block text-sm text-[var(--lagoon-deep)]"
          >
            {meeting.meetLink}
          </a>
        ) : null}
        <p className="mt-3 text-sm text-[var(--sea-ink)]">
          Meeting: <span className="font-medium">{meeting.status}</span>
          {meeting.workflowStatus
            ? ` · workflow ${meeting.workflowStatus}`
            : ''}
        </p>
        {meeting.workflowError ? (
          <p className="mt-1 text-sm text-red-600">{meeting.workflowError}</p>
        ) : null}
        {run?.errorMessage ? (
          <p className="mt-1 text-sm text-red-600">{run.errorMessage}</p>
        ) : null}
      </header>

      <section className="island-shell mt-8 rounded-2xl px-5 py-5 sm:px-8">
        <h2 className="text-sm font-semibold text-[var(--sea-ink)]">
          Call overview
        </h2>
        {!run ? (
          <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
            Bot has not started for this meeting yet.
          </p>
        ) : (
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-[var(--sea-ink-soft)]">Bot joined</dt>
              <dd className="font-medium text-[var(--sea-ink)]">
                {formatWhen(run.joinedAt)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--sea-ink-soft)]">Bot left / ended</dt>
              <dd className="font-medium text-[var(--sea-ink)]">
                {formatWhen(run.leftAt)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--sea-ink-soft)]">Duration</dt>
              <dd className="font-medium text-[var(--sea-ink)]">
                {formatDuration(run.durationMs)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--sea-ink-soft)]">People observed</dt>
              <dd className="font-medium text-[var(--sea-ink)]">
                {run.uniqueAttendeeCount ?? run.attendees.length}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--sea-ink-soft)]">Leave reason</dt>
              <dd className="font-medium text-[var(--sea-ink)]">
                {run.leaveReason?.replace(/_/g, ' ') ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-[var(--sea-ink-soft)]">Bot status</dt>
              <dd className="font-medium text-[var(--sea-ink)]">{run.status}</dd>
            </div>
          </dl>
        )}

        {run ? (
          <>
            <ol className="mt-4 flex flex-wrap gap-2">
              {timeline.map((step) => (
                <li
                  key={step.id}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    step.current
                      ? 'bg-[var(--lagoon-deep)] text-white'
                      : step.done
                        ? 'bg-black/10 text-[var(--sea-ink)]'
                        : 'bg-black/5 text-[var(--sea-ink-soft)]'
                  }`}
                >
                  {step.id.replace(/_/g, ' ')}
                </li>
              ))}
            </ol>
            <p className="mt-3 font-mono text-xs text-[var(--sea-ink-soft)]">
              {run.recordingKey ? `audio ${run.recordingKey}` : 'no audio key'}
            </p>
          </>
        ) : null}

        {meeting.participants.length > 0 ? (
          <div className="mt-4">
            <h3 className="text-xs font-semibold text-[var(--sea-ink-soft)]">
              Calendar invitees
            </h3>
            <ul className="mt-2 space-y-1 text-sm text-[var(--sea-ink-soft)]">
              {meeting.participants.map((p) => (
                <li key={p.email}>
                  {p.displayName ?? p.email}
                  {p.responseStatus ? ` · ${p.responseStatus}` : ''}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="island-shell mt-8 rounded-2xl px-5 py-5 sm:px-8">
        <Tabs defaultValue="transcript">
          <TabsList>
            <TabsTrigger value="transcript">Transcript</TabsTrigger>
            <TabsTrigger value="summary">AI summary</TabsTrigger>
            <TabsTrigger value="attendance">Attendance</TabsTrigger>
          </TabsList>

          <TabsContent value="transcript" className="mt-4">
            {!run ? (
              <p className="text-sm text-[var(--sea-ink-soft)]">
                No bot run yet.
              </p>
            ) : run.status === 'joined' ||
              run.status === 'joining' ||
              run.status === 'waiting_admission' ? (
              <p className="text-sm text-[var(--sea-ink-soft)]">
                Meeting in progress — transcript will appear after the bot
                leaves and uploads audio.
              </p>
            ) : run.transcriptText ? (
              <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-lg bg-black/5 p-4 text-sm text-[var(--sea-ink)]">
                {run.transcriptText}
              </pre>
            ) : run.status === 'failed' ? (
              <p className="text-sm text-red-600">
                Bot failed{run.errorMessage ? `: ${run.errorMessage}` : '.'}
              </p>
            ) : (
              <p className="text-sm text-[var(--sea-ink-soft)]">
                No transcript yet
                {run.recordingKey
                  ? ' (audio saved; transcription may have failed).'
                  : '.'}
              </p>
            )}
          </TabsContent>

          <TabsContent value="summary" className="mt-4">
            {!notes ? (
              <p className="text-sm text-[var(--sea-ink-soft)]">
                {run?.transcriptText
                  ? 'Notes workflow not started yet — refresh shortly.'
                  : 'AI summary appears after transcription completes.'}
              </p>
            ) : notes.status === 'pending' || notes.status === 'running' ? (
              <p className="text-sm text-[var(--sea-ink-soft)]">
                Generating summary and action items…
              </p>
            ) : notes.status === 'failed' ? (
              <p className="text-sm text-red-600">
                Notes failed
                {notes.errorMessage ? `: ${notes.errorMessage}` : '.'}
              </p>
            ) : (
              <div className="space-y-6">
                <div>
                  <h3 className="text-sm font-semibold text-[var(--sea-ink)]">
                    Summary
                  </h3>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--sea-ink)]">
                    {notes.summaryText || '—'}
                  </p>
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-[var(--sea-ink)]">
                    Action items
                  </h3>
                  {notes.actionItems.length === 0 ? (
                    <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
                      None detected.
                    </p>
                  ) : (
                    <ul className="mt-2 list-disc space-y-2 pl-5 text-sm text-[var(--sea-ink)]">
                      {notes.actionItems.map((item, i) => (
                        <li key={`${item.text}-${i}`}>
                          {item.text}
                          {item.assignee ? ` — ${item.assignee}` : ''}
                          {item.dueDate ? ` (due ${item.dueDate})` : ''}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="attendance" className="mt-4">
            {!run ? (
              <p className="text-sm text-[var(--sea-ink-soft)]">
                No bot run yet.
              </p>
            ) : run.attendees.length === 0 ? (
              <p className="text-sm text-[var(--sea-ink-soft)]">
                No live attendees captured yet
                {run.status === 'left'
                  ? ' (Meet UI may hide names from the bot).'
                  : ' — polled throughout the call; available after the bot leaves.'}
              </p>
            ) : (
              <div className="space-y-3">
                <p className="text-xs text-[var(--sea-ink-soft)]">
                  Everyone observed during the call ({run.attendees.length}).
                  Sync: {run.attendanceSyncStatus ?? '—'}
                  {run.attendanceSyncError
                    ? ` · ${run.attendanceSyncError}`
                    : ''}
                </p>
                <ul className="divide-y divide-[var(--line)] text-sm text-[var(--sea-ink)]">
                  {run.attendees.map((person, i) => (
                    <li key={`${person.name}-${i}`} className="py-2">
                      <div className="font-medium">
                        {person.name}
                        {person.email ? ` · ${person.email}` : ''}
                        {person.leftDuringCall ? (
                          <span className="ml-2 text-xs font-normal text-[var(--sea-ink-soft)]">
                            left mid-call
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-xs text-[var(--sea-ink-soft)]">
                        first seen {formatWhen(person.firstSeenAt)}
                        {person.lastSeenAt
                          ? ` · last seen ${formatWhen(person.lastSeenAt)}`
                          : ''}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </section>
    </main>
  )
}
