import OpenAI from 'openai'
import { z } from 'zod'

export const MeetingNotesSchema = z.object({
  summary: z.string().describe('Concise meeting summary in 2-5 paragraphs'),
  actionItems: z
    .array(
      z.object({
        text: z.string(),
        assignee: z.string().nullable().optional(),
        dueDate: z.string().nullable().optional(),
      }),
    )
    .describe('Action items extracted from the meeting'),
})

export type MeetingNotes = z.infer<typeof MeetingNotesSchema>

export type TranscribeAudioInput = {
  /** Raw audio bytes */
  bytes: ArrayBuffer | Uint8Array
  /** Filename hint for OpenAI (extension matters) */
  filename?: string
  /** MIME type, e.g. audio/webm */
  contentType?: string
}

function getClient(apiKey?: string) {
  const key = apiKey || process.env.OPENAI_API_KEY
  if (!key) {
    throw new Error('OPENAI_API_KEY is required')
  }
  return new OpenAI({ apiKey: key })
}

/**
 * Speech-to-text via OpenAI (Whisper). Returns plain transcript text.
 */
export async function transcribeAudio(
  input: TranscribeAudioInput,
  apiKey?: string,
): Promise<string> {
  const client = getClient(apiKey)
  const filename = input.filename || 'meeting.webm'
  const type = input.contentType || 'audio/webm'
  const normalized =
    input.bytes instanceof Uint8Array
      ? new Uint8Array(input.bytes)
      : new Uint8Array(input.bytes)
  const blob = new Blob([normalized], { type })
  const file = new File([blob], filename, { type })

  const result = await client.audio.transcriptions.create({
    file,
    model: 'whisper-1',
    response_format: 'text',
  })

  const text = typeof result === 'string' ? result.trim() : String(result).trim()
  if (!text) {
    throw new Error('OpenAI Whisper returned empty transcript')
  }
  return text
}

/**
 * Summarize a meeting transcript into summary + action items (JSON mode).
 */
export async function summarizeMeeting(
  transcript: string,
  apiKey?: string,
): Promise<MeetingNotes> {
  const client = getClient(apiKey)
  const trimmed = transcript.trim()
  if (!trimmed) {
    throw new Error('Cannot summarize empty transcript')
  }

  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You are a meeting notes assistant. Given a transcript, return JSON with keys "summary" (string) and "actionItems" (array of { text, assignee?, dueDate? }). Use null for unknown assignee/dueDate. Be concise and faithful to the transcript.',
      },
      {
        role: 'user',
        content: `Transcript:\n\n${trimmed.slice(0, 120_000)}`,
      },
    ],
  })

  const raw = completion.choices[0]?.message?.content
  if (!raw) {
    throw new Error('OpenAI returned empty summary response')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('OpenAI summary was not valid JSON')
  }

  return MeetingNotesSchema.parse(parsed)
}
