/**
 * Speech-to-text via Cloudflare Workers AI (Whisper).
 * Returns plain text suitable for LLM analysis.
 */
export async function transcribeAudio(
  ai: Ai,
  audioBytes: ArrayBuffer,
): Promise<string> {
  const audio = [...new Uint8Array(audioBytes)]

  const result = (await ai.run('@cf/openai/whisper', {
    audio,
  })) as { text?: string }

  const text = result?.text?.trim() ?? ''
  if (!text) {
    throw new Error('Whisper returned empty transcript')
  }
  return text
}
