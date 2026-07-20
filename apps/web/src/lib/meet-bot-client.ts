import { getContainer } from '@cloudflare/containers'
import { env } from 'cloudflare:workers'

/** Optional local override: point at a host-run meet-bot (see `.dev.vars`). */
type EnvWithHostBot = Env & { MEET_BOT_URL?: string }

export type MeetBotJoinBody = {
  meetingId: string
  meetLink: string
  displayName: string
  botRunId: string
  endsAtMs: number
  workflowInstanceId: string
  callbackBaseUrl: string
  callbackSecret: string
}

function hostBotUrl(): string {
  return ((env as EnvWithHostBot).MEET_BOT_URL || '').replace(/\/$/, '')
}

function botSecretHeaders(): Record<string, string> {
  const secret = env.BOT_INTERNAL_SECRET
  return secret ? { 'x-bot-secret': secret } : {}
}

/** One container stub per meeting id (session affinity). */
export function getMeetBotContainer(meetingId: string) {
  return getContainer(env.MEET_BOT_CONTAINER, meetingId)
}

/**
 * Container → host callbacks can't use localhost; rewrite for Docker Desktop.
 * Host-run bots talk to vite on the same machine — keep localhost.
 */
export function resolveCallbackBaseUrl(raw: string): string {
  const base = raw.replace(/\/$/, '')
  if (hostBotUrl()) return base
  try {
    const url = new URL(base)
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      url.hostname = 'host.docker.internal'
      return url.toString().replace(/\/$/, '')
    }
  } catch {
    // keep as-is
  }
  return base
}

/** POST /join — host bot or Cloudflare Container. */
export async function joinMeetBot(
  body: MeetBotJoinBody,
): Promise<Response> {
  const hostUrl = hostBotUrl()
  const headers = {
    'content-type': 'application/json',
    ...botSecretHeaders(),
  }
  const payload = JSON.stringify(body)

  if (hostUrl) {
    console.log(
      JSON.stringify({
        msg: 'meet-bot join via host',
        url: `${hostUrl}/join`,
        meetingId: body.meetingId,
      }),
    )
    return fetch(`${hostUrl}/join`, {
      method: 'POST',
      headers,
      body: payload,
    })
  }

  const container = getMeetBotContainer(body.meetingId)
  console.log(
    JSON.stringify({
      msg: 'meet-bot join via container',
      meetingId: body.meetingId,
    }),
  )
  await container.startAndWaitForPorts({
    startOptions: {
      envVars: {
        BOT_INTERNAL_SECRET: env.BOT_INTERNAL_SECRET ?? '',
      },
    },
  })
  return container.fetch(
    new Request('http://container/join', {
      method: 'POST',
      headers,
      body: payload,
    }),
  )
}

/** POST /stop — ask bot to leave; container DO also tears down the VM. */
export async function stopMeetBot(meetingId: string): Promise<void> {
  const headers = botSecretHeaders()
  const hostUrl = hostBotUrl()

  if (hostUrl) {
    await fetch(`${hostUrl}/stop`, { method: 'POST', headers })
    return
  }

  const container = getMeetBotContainer(meetingId)
  await container.fetch(
    new Request('http://container/stop', { method: 'POST', headers }),
  )
}
