/**
 * Cron helper — intentionally a no-op for bot scheduling.
 * Bots are started manually per meeting from the dashboard to avoid
 * spawning workflows (and container cost) for every calendar event.
 */
export async function rescheduleUpcomingMeetings() {
  console.log(
    '[cron] skip auto-schedule — bots are requested manually per meeting',
  )
  return { meetings: 0, scheduled: 0 }
}
