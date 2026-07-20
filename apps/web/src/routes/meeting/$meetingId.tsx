import { useState } from 'react'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { getMeetingDetail } from '#/lib/meeting-detail'
import { regenerateNotes } from '#/lib/regenerate-notes'
import { getSession } from '#/lib/session'
import { botTimeline, formatDuration, formatWhen } from '#/lib/utils'

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

function MeetingDetailPage() {
  const router = useRouter()
  const { meeting, error } = Route.useLoaderData()
  const [regenerating, setRegenerating] = useState(false)
  const [notesError, setNotesError] = useState<string | null>(null)

  async function handleRegenerateNotes(meetingId: string) {
    setNotesError(null)
    setRegenerating(true)
    try {
      const result = await regenerateNotes({ data: { meetingId } })
      if (!result.ok) {
        setNotesError(result.error ?? 'Failed to regenerate notes')
        return
      }
      await router.invalidate()
    } catch (err) {
      setNotesError(err instanceof Error ? err.message : String(err))
    } finally {
      setRegenerating(false)
    }
  }

  if (error || !meeting) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-12">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/">← Meetings</Link>
        </Button>
        <Alert variant="destructive" className="mt-6">
          <AlertDescription>{error ?? 'Not found'}</AlertDescription>
        </Alert>
      </main>
    )
  }

  const run = meeting.botRun
  const notes = meeting.notes
  const timeline = botTimeline(run?.status)

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-12">
      <Button variant="ghost" size="sm" asChild>
        <Link to="/">← Meetings</Link>
      </Button>

      <Card>
        <CardHeader>
          <CardTitle className="text-2xl tracking-tight sm:text-3xl">
            {meeting.title}
          </CardTitle>
          <CardDescription>
            Calendar: {formatWhen(meeting.startsAt, 'datetime')} –{' '}
            {formatWhen(meeting.endsAt, 'datetime')}
          </CardDescription>
          {meeting.meetLink ? (
            <a
              href={meeting.meetLink}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-muted-foreground hover:text-foreground hover:underline"
            >
              {meeting.meetLink}
            </a>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Badge variant="outline">{meeting.status}</Badge>
            {meeting.workflowStatus ? (
              <Badge variant="secondary">
                workflow {meeting.workflowStatus}
              </Badge>
            ) : null}
          </div>
          {meeting.workflowError ? (
            <Alert variant="destructive">
              <AlertDescription>{meeting.workflowError}</AlertDescription>
            </Alert>
          ) : null}
          {run?.errorMessage ? (
            <Alert variant="destructive">
              <AlertDescription>{run.errorMessage}</AlertDescription>
            </Alert>
          ) : null}
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Call overview</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!run ? (
            <p className="text-sm text-muted-foreground">
              Bot has not started for this meeting yet.
            </p>
          ) : (
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Bot joined</dt>
                <dd className="mt-0.5 font-medium">
                  {formatWhen(run.joinedAt, 'datetime')}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  Bot left / ended
                </dt>
                <dd className="mt-0.5 font-medium">{formatWhen(run.leftAt, 'datetime')}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Duration</dt>
                <dd className="mt-0.5 font-medium">
                  {formatDuration(run.durationMs)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  People observed
                </dt>
                <dd className="mt-0.5 font-medium">
                  {run.uniqueAttendeeCount ?? run.attendees.length}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Leave reason</dt>
                <dd className="mt-0.5 font-medium">
                  {run.leaveReason?.replace(/_/g, ' ') ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Bot status</dt>
                <dd className="mt-0.5">
                  <Badge variant="secondary">{run.status}</Badge>
                </dd>
              </div>
            </dl>
          )}

          {run ? (
            <div className="flex flex-wrap gap-1.5">
              {timeline.map((step) => (
                <Badge
                  key={step.id}
                  variant={
                    step.current
                      ? 'default'
                      : step.done
                        ? 'secondary'
                        : 'outline'
                  }
                >
                  {step.id.replace(/_/g, ' ')}
                </Badge>
              ))}
            </div>
          ) : null}

          {meeting.participants.length > 0 ? (
            <div>
              <h3 className="text-xs font-medium text-muted-foreground">
                Calendar invitees
              </h3>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                {meeting.participants.map((p) => (
                  <li key={p.email}>
                    {p.displayName ?? p.email}
                    {p.responseStatus ? ` · ${p.responseStatus}` : ''}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {run?.recordingKey ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recording</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Streams through /api/recording/:botRunId (Nextcloud is behind
                Basic auth). webm/opus plays in Chrome & Firefox; Safari cannot. */}
            <audio
              controls
              preload="none"
              className="w-full"
              src={`/api/recording/${run.id}`}
            >
              Your browser can’t play this recording.
            </audio>
            <a
              href={`/api/recording/${run.id}?download=1`}
              className="inline-block text-sm text-muted-foreground hover:text-foreground hover:underline"
            >
              Download audio (.webm)
            </a>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-6">
          <Tabs defaultValue="transcript">
            <TabsList>
              <TabsTrigger value="transcript">Transcript</TabsTrigger>
              <TabsTrigger value="summary">AI summary</TabsTrigger>
              <TabsTrigger value="attendance">Attendance</TabsTrigger>
            </TabsList>

            <TabsContent value="transcript" className="mt-4">
              {!run ? (
                <p className="text-sm text-muted-foreground">No bot run yet.</p>
              ) : run.status === 'joined' ||
                run.status === 'joining' ||
                run.status === 'waiting_admission' ? (
                <p className="text-sm text-muted-foreground">
                  Meeting in progress — transcript appears after the bot leaves.
                </p>
              ) : run.transcriptText ? (
                <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap text-sm">
                  {run.transcriptText}
                </pre>
              ) : run.status === 'failed' ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    Bot failed{run.errorMessage ? `: ${run.errorMessage}` : '.'}
                  </AlertDescription>
                </Alert>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No transcript yet
                  {run.recordingKey
                    ? ' (audio saved; transcription may have failed).'
                    : '.'}
                </p>
              )}
            </TabsContent>

            <TabsContent value="summary" className="mt-4 space-y-4">
              {!notes ? (
                <p className="text-sm text-muted-foreground">
                  {run?.transcriptText
                    ? 'Notes workflow not started yet — refresh shortly.'
                    : 'AI summary appears after transcription completes.'}
                </p>
              ) : notes.status === 'pending' || notes.status === 'running' ? (
                <p className="text-sm text-muted-foreground">
                  Generating summary and action items…
                </p>
              ) : notes.status === 'failed' ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    Notes failed
                    {notes.errorMessage ? `: ${notes.errorMessage}` : '.'}
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="space-y-6">
                  <div>
                    <h3 className="text-sm font-medium">Summary</h3>
                    <p className="mt-2 whitespace-pre-wrap text-sm">
                      {notes.summaryText || '—'}
                    </p>
                  </div>
                  <div>
                    <h3 className="text-sm font-medium">Action items</h3>
                    {notes.actionItems.length === 0 ? (
                      <p className="mt-2 text-sm text-muted-foreground">
                        None detected.
                      </p>
                    ) : (
                      <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm">
                        {notes.actionItems.map((item, i) => (
                          <li key={`${item.text}-${i}`}>
                            {item.text}
                            {item.assignee ? ` — ${item.assignee}` : ''}
                            {item.dueDate ? ` (due ${item.dueDate})` : ''}
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                </div>
              )}

              {/* Retry / regenerate — only meaningful once a transcript exists
                  and notes aren't already being generated. */}
              {run?.transcriptText &&
              notes?.status !== 'pending' &&
              notes?.status !== 'running' ? (
                <div className="flex flex-wrap items-center gap-2 border-t pt-4">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={regenerating}
                    onClick={() => handleRegenerateNotes(meeting.id)}
                  >
                    {regenerating
                      ? 'Starting…'
                      : notes?.status === 'failed'
                        ? 'Retry notes'
                        : notes
                          ? 'Regenerate notes'
                          : 'Generate notes'}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Re-runs the AI summary from the transcript.
                  </span>
                </div>
              ) : null}

              {notesError ? (
                <Alert variant="destructive">
                  <AlertDescription>{notesError}</AlertDescription>
                </Alert>
              ) : null}
            </TabsContent>

            <TabsContent value="attendance" className="mt-4">
              {!run ? (
                <p className="text-sm text-muted-foreground">No bot run yet.</p>
              ) : run.attendees.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No live attendees captured yet
                  {run.status === 'left'
                    ? ' (Meet UI may hide names from the bot).'
                    : ' — available after the bot leaves.'}
                </p>
              ) : (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Everyone observed during the call ({run.attendees.length}).
                    Sync: {run.attendanceSyncStatus ?? '—'}
                    {run.attendanceSyncError
                      ? ` · ${run.attendanceSyncError}`
                      : ''}
                  </p>
                  <ol className="space-y-3">
                    {run.attendees.map((person, i) => (
                      <li
                        key={`${person.name}-${i}`}
                        className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
                      >
                        <div className="flex gap-3">
                          <span className="w-6 shrink-0 tabular-nums text-muted-foreground">
                            {i + 1}.
                          </span>
                          <div className="min-w-0">
                            <div className="font-medium">
                              {person.name}
                              {person.email ? ` · ${person.email}` : ''}
                              {person.leftDuringCall ? (
                                <Badge variant="outline" className="ml-2">
                                  left mid-call
                                </Badge>
                              ) : null}
                            </div>
                            <div className="mt-0.5 text-xs text-muted-foreground">
                              first seen {formatWhen(person.firstSeenAt, 'datetime')}
                              {person.lastSeenAt
                                ? ` · last seen ${formatWhen(person.lastSeenAt, 'datetime')}`
                                : ''}
                            </div>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </main>
  )
}
