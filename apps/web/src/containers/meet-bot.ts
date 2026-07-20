import { Container, type StopParams } from '@cloudflare/containers'

const ACTIVE_STATES = new Set([
  'joining',
  'waiting_admission',
  'joined',
  'recording',
  'leaving',
])

/**
 * One Chromium Meet bot per meeting id:
 * `getContainer(env.MEET_BOT_CONTAINER, meetingId)`.
 *
 * Image defaults (BOT_HEADED, PulseAudio, Chrome profile) live in the Dockerfile.
 * Secrets are passed at start via `startAndWaitForPorts({ startOptions.envVars })`.
 */
export class MeetBotContainer extends Container {
  defaultPort = 8080
  requiredPorts = [8080]
  /** Renewed while a join/recording session is active (see onActivityExpired). */
  sleepAfter = '15m'
  enableInternet = true
  pingEndpoint = '/health'

  override onStart(): void {
    console.log(
      JSON.stringify({ msg: 'meet-bot container started', id: this.ctx.id.toString() }),
    )
  }

  override onStop(params: StopParams): void {
    console.log(
      JSON.stringify({
        msg: 'meet-bot container stopped',
        id: this.ctx.id.toString(),
        exitCode: params.exitCode,
        reason: params.reason,
      }),
    )
  }

  override onError(error: unknown): void {
    console.error(
      JSON.stringify({
        msg: 'meet-bot container error',
        id: this.ctx.id.toString(),
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    throw error
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // Explicit stop: ask the bot to leave, then shut down the VM.
    if (request.method === 'POST' && url.pathname === '/stop') {
      try {
        await this.containerFetch(request)
      } catch (error) {
        console.error('[MeetBotContainer] bot /stop failed', error)
      }
      try {
        await this.stop()
      } catch (error) {
        console.error('[MeetBotContainer] container stop failed', error)
        await this.destroy().catch(() => undefined)
      }
      return Response.json({ stopped: true })
    }

    return super.fetch(request)
  }

  override async onActivityExpired(): Promise<void> {
    try {
      const response = await this.containerFetch(
        new Request('http://container/status'),
      )
      const body = (await response.json()) as { state?: string }
      if (ACTIVE_STATES.has(body.state ?? 'idle')) {
        this.renewActivityTimeout()
        return
      }
    } catch {
      // Status unreachable — shut down.
    }
    await this.stop()
  }
}
