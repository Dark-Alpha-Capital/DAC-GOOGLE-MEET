import { Container } from '@cloudflare/containers'

/**
 * One Chromium Meet bot per meeting id (`getContainer(env.MEET_BOT_CONTAINER, meetingId)`).
 * sleepAfter is long; onActivityExpired renews instead of stopping while a job may still run.
 */
export class MeetBotContainer extends Container {
  defaultPort = 8080
  sleepAfter = '3h'
  enableInternet = true
  pingEndpoint = '/health'
  envVars = {
    BOT_HEADED: '1',
  }

  override async onActivityExpired(): Promise<void> {
    // Do not stop — Meet sessions outlive idle HTTP gaps. Finalize step stops explicitly.
    this.renewActivityTimeout()
  }
}
