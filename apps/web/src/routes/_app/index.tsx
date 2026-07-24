import { createFileRoute } from '@tanstack/react-router'

import { ConferencesList } from '#/components/conferences-list'
import { Alert, AlertDescription } from '#/components/ui/alert'
import { Skeleton } from '#/components/ui/skeleton'
import { getMeetConferences } from '#/lib/meet-attendance'

export const Route = createFileRoute('/_app/')({
  pendingComponent: MeetingsPending,
  loader: async () => {
    try {
      return await getMeetConferences()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[meetings] getMeetConferences failed:', message)
      return { conferences: [], error: message }
    }
  },
  component: MeetingsPage,
})

function MeetingsPending() {
  return (
    <main
      className="mx-auto max-w-7xl px-4 py-12 sm:px-6"
      aria-busy="true"
      aria-label="Loading meetings"
    >
      <div className="mb-10 space-y-2">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-64 w-full" />
    </main>
  )
}

function MeetingsPage() {
  const { session } = Route.useRouteContext()
  const { conferences, error } = Route.useLoaderData()

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
          Recent Google Meet conferences (~30-day retention). Open a meeting for
          attendance.
        </p>
      </div>

      {error ? (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <ConferencesList
        conferences={conferences}
        emptyMessage="No recent conference records found (or none within the 30-day retention window)."
      />
    </main>
  )
}
