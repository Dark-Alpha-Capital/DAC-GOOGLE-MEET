export type MeetingAttendee = {
  name: string
  email?: string | null
}

export type AttendancePayload = {
  meetingId: string
  botRunId: string
  title: string
  meetLink: string | null
  startedAt: string | null
  endedAt: string
  attendees: MeetingAttendee[]
}

/**
 * Record attendance with an external HR/ops API.
 * Until ATTENDANCE_API_URL is configured, this simulates a successful POST.
 */
export async function recordAttendance(
  payload: AttendancePayload,
  options?: { apiUrl?: string; apiKey?: string },
): Promise<{ mode: 'simulated' | 'sent'; responseStatus?: number }> {
  const apiUrl = options?.apiUrl || process.env.ATTENDANCE_API_URL || ''

  if (!apiUrl) {
    console.log(
      `[attendance] SIMULATED POST meeting=${payload.meetingId} botRun=${payload.botRunId} attendees=${payload.attendees.length}`,
      JSON.stringify(payload.attendees),
    )
    return { mode: 'simulated' }
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  const apiKey = options?.apiKey || process.env.ATTENDANCE_API_KEY
  if (apiKey) headers.authorization = `Bearer ${apiKey}`

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `Attendance API failed (${response.status}): ${text.slice(0, 300)}`,
    )
  }

  console.log(
    `[attendance] SENT meeting=${payload.meetingId} status=${response.status} attendees=${payload.attendees.length}`,
  )
  return { mode: 'sent', responseStatus: response.status }
}

export function parseAttendeesJson(raw: string | null | undefined): MeetingAttendee[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: MeetingAttendee[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const row = item as { name?: unknown; email?: unknown }
      const name = typeof row.name === 'string' ? row.name.trim() : ''
      if (!name) continue
      out.push({
        name,
        email: typeof row.email === 'string' ? row.email : null,
      })
    }
    return out
  } catch {
    return []
  }
}
