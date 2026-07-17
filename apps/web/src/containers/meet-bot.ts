import { Container } from '@cloudflare/containers'
import { env } from 'cloudflare:workers'

/**
 * One Chromium Meet bot per meeting id (`getContainer(env.MEET_BOT_CONTAINER, meetingId)`).
 * sleepAfter is long; onActivityExpired renews instead of stopping while a job may still run.
 */
export class MeetBotContainer extends Container {
  defaultPort = 8080
  sleepAfter = '15m'
  enableInternet = true
  pingEndpoint = '/health'
  envVars = {
    BOT_HEADED: '1',
    /** Use baked Chromium profile at /data/chrome (roghankundra session). */
    USE_CHROME_PROFILE: '1',
    BOT_USER_DATA_DIR: '/data/chrome',
    BOT_PROFILE_DIRECTORY: 'Default',
    /** Docker has PulseAudio meet_sink — not browser MediaRecorder. */
    BOT_RECORD_MODE: 'ffmpeg',
    PULSE_SINK: 'meet_sink',
    /** Optional; when set, meet-bot requires x-bot-secret on /join and /stop. */
    BOT_INTERNAL_SECRET: env.BOT_INTERNAL_SECRET ?? '',
  }

  override async onActivityExpired(): Promise<void> {
    // Stop idle/finished bots so instances don't live forever.
    // Renew only while an active join/recording session is in progress.
    try {
      const response = await this.containerFetch(
        new Request('http://container/status'),
      )
      const body = (await response.json()) as { state?: string }
      const state = body.state ?? 'idle'
      if (
        state === 'joining' ||
        state === 'waiting_admission' ||
        state === 'joined' ||
        state === 'recording' ||
        state === 'leaving'
      ) {
        this.renewActivityTimeout()
        return
      }
    } catch {
      // If status is unreachable, shut down.
    }
    await this.stop()
  }
}
