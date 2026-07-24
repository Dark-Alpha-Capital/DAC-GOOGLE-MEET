import { createFileRoute, Link } from '@tanstack/react-router'

import { ConferencesList } from '#/components/conferences-list'
import { Alert, AlertDescription } from '#/components/ui/alert'
import { Skeleton } from '#/components/ui/skeleton'
import { getMeetConferences } from '#/lib/meet-attendance'

export const Route = createFileRoute('/_app/history')({
  pendingComponent: HistoryPending,
  loader: async () => {
    try {
      const result = await getMeetConferences()
      const conferences = result.conferences.filter((c) => c.endTime !== null)
      return { conferences, error: result.error }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[history] getMeetConferences failed:', message)
      return { conferences: [], error: message }
    }
  },
  component: HistoryPage,
})

function HistoryPending() {
  return (
    <main
      className="mx-auto max-w-7xl px-4 py-12 sm:px-6"
      aria-busy="true"
      aria-label="Loading history"
    >
      <div className="mb-10 space-y-2">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-64 w-full" />
    </main>
  )
}

function HistoryPage() {
  const { conferences, error } = Route.useLoaderData()

  return (
    <main className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
      <div className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          History
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Ended Meet conferences from your recent history.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          <Link to="/" className="hover:text-foreground hover:underline">
            ← Back to meetings
          </Link>
        </p>
      </div>

      {error ? (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <ConferencesList
        conferences={conferences}
        emptyMessage="No ended conferences in the recent retention window."
      />
    </main>
  )
}
