/**
 * Constant-time compare for bot ↔ worker shared secret (`x-bot-secret`).
 * Returns false when either side is missing.
 */
export function isValidBotSecret(
  request: Request,
  expected: string | undefined,
): boolean {
  if (!expected) return false
  const provided = request.headers.get('x-bot-secret')
  if (!provided) return false

  const encoder = new TextEncoder()
  const a = encoder.encode(provided)
  const b = encoder.encode(expected)
  if (a.byteLength !== b.byteLength) return false

  // Workers expose timingSafeEqual on SubtleCrypto; DOM lib typings omit it.
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(x: ArrayBufferView, y: ArrayBufferView): boolean
  }
  return subtle.timingSafeEqual(a, b)
}

export function unauthorizedBot(): Response {
  return Response.json({ error: 'Unauthorized' }, { status: 401 })
}
