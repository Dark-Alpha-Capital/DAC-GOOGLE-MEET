import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { meeting } from '#/db/schema'
import { getAuth } from '#/lib/auth'

export type SearchResult = {
  meetingId: string
  title: string
  startsAt: Date
  matchedIn: 'title' | 'transcript' | 'summary'
  snippet: string
}

const MAX_RESULTS = 50

/** ~180-char window of text centered on the first match, with ellipses. */
function buildSnippet(text: string, needle: string): string {
  const idx = text.toLowerCase().indexOf(needle)
  if (idx === -1) return text.slice(0, 180)
  const start = Math.max(0, idx - 60)
  const end = Math.min(text.length, idx + needle.length + 120)
  const core = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '… ' : ''}${core}${end < text.length ? ' …' : ''}`
}

/**
 * Keyword search across the caller's meetings: title, transcript, and AI
 * summary. Case-insensitive substring match.
 *
 * ponytail: in-memory scan — loads the user's transcripts and filters in JS.
 * Fine at MVP scale (one user, tens–hundreds of meetings). Move to SQLite FTS5
 * (a virtual table + MATCH query) if meeting volume or transcript size grows.
 */
export const searchMeetings = createServerFn({ method: 'GET' })
  .validator((data: unknown) => {
    const query =
      typeof data === 'object' &&
      data &&
      'query' in data &&
      typeof (data as { query: unknown }).query === 'string'
        ? (data as { query: string }).query
        : ''
    return { query }
  })
  .handler(
    async ({
      data,
    }): Promise<{ results: SearchResult[]; error?: string }> => {
      const headers = getRequestHeaders()
      const session = await getAuth().api.getSession({ headers })
      if (!session) {
        return { results: [], error: 'Not signed in' }
      }

      const needle = data.query.trim().toLowerCase()
      if (needle.length < 2) {
        return { results: [] }
      }

      const rows = await getDb().query.meeting.findMany({
        where: eq(meeting.userId, session.user.id),
        with: {
          botRuns: true,
          notes: true,
        },
      })

      const results: SearchResult[] = []
      for (const row of rows) {
        // Priority order: title → transcript → summary. First hit wins.
        if (row.title.toLowerCase().includes(needle)) {
          results.push({
            meetingId: row.id,
            title: row.title,
            startsAt: row.startsAt,
            matchedIn: 'title',
            snippet: row.title,
          })
          continue
        }

        const transcript = row.botRuns
          .map((r) => r.transcriptText)
          .find((t) => t && t.toLowerCase().includes(needle))
        if (transcript) {
          results.push({
            meetingId: row.id,
            title: row.title,
            startsAt: row.startsAt,
            matchedIn: 'transcript',
            snippet: buildSnippet(transcript, needle),
          })
          continue
        }

        const summary = row.notes
          .map((n) => n.summaryText)
          .find((s) => s && s.toLowerCase().includes(needle))
        if (summary) {
          results.push({
            meetingId: row.id,
            title: row.title,
            startsAt: row.startsAt,
            matchedIn: 'summary',
            snippet: buildSnippet(summary, needle),
          })
        }
      }

      // Most recent first, capped.
      results.sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())
      return { results: results.slice(0, MAX_RESULTS) }
    },
  )
