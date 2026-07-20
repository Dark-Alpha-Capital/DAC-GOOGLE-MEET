import { createFileRoute } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { botRun } from '#/db/schema'
import { getAuth } from '#/lib/auth'
import { getStorage } from '#/lib/storage'

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'recording'
}

/**
 * Streams a bot run's audio recording from Nextcloud through the worker.
 * The file lives behind Basic auth the browser can't send, so we proxy it and
 * gate access to the meeting's owner. `?download=1` forces a save dialog.
 */
export const Route = createFileRoute('/api/recording/$botRunId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const session = await getAuth().api.getSession({
          headers: request.headers,
        })
        if (!session) {
          return Response.json({ error: 'Not signed in' }, { status: 401 })
        }

        const run = await getDb().query.botRun.findFirst({
          where: eq(botRun.id, params.botRunId),
          with: { meeting: true },
        })

        // 404 for missing OR not-owned so we don't leak which ids exist.
        if (!run || run.meeting.userId !== session.user.id) {
          return Response.json({ error: 'Not found' }, { status: 404 })
        }
        if (!run.recordingKey) {
          return Response.json(
            { error: 'No recording for this meeting' },
            { status: 404 },
          )
        }

        const object = await getStorage().get(run.recordingKey)
        if (!object) {
          return Response.json(
            { error: 'Recording file is missing from storage' },
            { status: 404 },
          )
        }

        const url = new URL(request.url)
        const download = url.searchParams.get('download') === '1'
        const filename = `${slugify(run.meeting.title)}.webm`

        const headers: Record<string, string> = {
          // Recordings are always webm/opus; trust the store only if it already
          // reports an audio type, else force audio/webm so <audio> can play it.
          'Content-Type': object.contentType?.startsWith('audio/')
            ? object.contentType
            : 'audio/webm',
          'Cache-Control': 'private, max-age=3600',
          'Content-Disposition': download
            ? `attachment; filename="${filename}"`
            : `inline; filename="${filename}"`,
        }
        if (object.contentLength != null) {
          headers['Content-Length'] = String(object.contentLength)
        }

        // ponytail: no HTTP Range support — full-file stream only. Seeking in the
        // <audio> element still works after the file loads; add Range handling if
        // large recordings need scrub-before-load.
        return new Response(object.body, { status: 200, headers })
      },
    },
  },
})
