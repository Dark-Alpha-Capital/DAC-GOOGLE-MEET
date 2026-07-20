import { useState, type FormEvent } from 'react'
import { createFileRoute, Link, redirect } from '@tanstack/react-router'

import { Alert, AlertDescription } from '#/components/ui/alert'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card, CardContent } from '#/components/ui/card'
import { Input } from '#/components/ui/input'
import { searchMeetings, type SearchResult } from '#/lib/search-meetings'
import { getSession } from '#/lib/session'
import { formatWhen } from '#/lib/utils'

export const Route = createFileRoute('/search')({
  beforeLoad: async () => {
    const session = await getSession()
    if (!session) {
      throw redirect({ to: '/login' })
    }
    return { session }
  },
  component: SearchPage,
})

function SearchPage() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)

  async function handleSearch(e: FormEvent) {
    e.preventDefault()
    const q = query.trim()
    if (q.length < 2) {
      setError('Enter at least 2 characters')
      return
    }
    setError(null)
    setLoading(true)
    try {
      const result = await searchMeetings({ data: { query: q } })
      if (result.error) {
        setError(result.error)
        return
      }
      setResults(result.results)
      setSearched(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <Button variant="ghost" size="sm" asChild>
        <Link to="/">← Meetings</Link>
      </Button>

      <h1 className="mt-6 text-3xl font-semibold tracking-tight">
        Search meetings
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Search across meeting titles, transcripts, and AI summaries.
      </p>

      <form onSubmit={handleSearch} className="mt-6 flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. pricing, roadmap, a name…"
          aria-label="Search query"
        />
        <Button type="submit" disabled={loading}>
          {loading ? 'Searching…' : 'Search'}
        </Button>
      </form>

      {error ? (
        <Alert variant="destructive" className="mt-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {searched && !error ? (
        <p className="mt-6 text-sm text-muted-foreground">
          {results.length === 0
            ? 'No matches found.'
            : `${results.length} match${results.length === 1 ? '' : 'es'}`}
        </p>
      ) : null}

      <ul className="mt-4 space-y-3">
        {results.map((r) => (
          <li key={`${r.meetingId}-${r.matchedIn}`}>
            <Card>
              <CardContent className="pt-6">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
                  <Link
                    to="/meeting/$meetingId"
                    params={{ meetingId: r.meetingId }}
                    className="font-medium hover:underline"
                  >
                    {r.title}
                  </Link>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatWhen(r.startsAt)}
                  </span>
                </div>
                <div className="mt-2 flex items-start gap-2">
                  <Badge variant="outline" className="shrink-0">
                    {r.matchedIn}
                  </Badge>
                  <p className="text-sm text-muted-foreground">{r.snippet}</p>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
    </main>
  )
}
