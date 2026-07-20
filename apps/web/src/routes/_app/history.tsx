import { createFileRoute, Link } from '@tanstack/react-router'

import { MeetingsDataTable } from '#/components/meetings-data-table'
import { Alert, AlertDescription } from '#/components/ui/alert'
import { Skeleton } from '#/components/ui/skeleton'
import { getBotHistory } from '#/lib/calendar'

export const Route = createFileRoute('/_app/history')({
  pendingComponent: HistoryPending,
  loader: async () => {
    try {
      return await getBotHistory()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[history] getBotHistory failed:', message)
      return { meetings: [], error: message }
    }
  },
  component: HistoryPage,
})

function HistoryPending() {
  return (
    <main
      className="mx-auto max-w-7xl px-4 py-12 sm:px-6"
      aria-busy="true"
      aria-label="Loading bot history"
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
  const { meetings, error } = Route.useLoaderData()

  return (
    <main className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
      <div className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Bot history
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Completed and cancelled meetings with join / recording outcome.
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

      <MeetingsDataTable
        data={meetings}
        emptyMessage="No completed bot runs yet."
        showActions={false}
      />
    </main>
  )
}
