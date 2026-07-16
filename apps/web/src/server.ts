import handler from '@tanstack/react-start/server-entry'

import { rescheduleUpcomingMeetings } from '#/lib/cron-sync'

export { MeetBotContainer } from '#/containers/meet-bot'
export { MeetingBotWorkflow } from '#/workflows/meeting-bot'
export { MeetingNotesWorkflow } from '#/workflows/meeting-notes'

export default {
  fetch: handler.fetch,
  async scheduled(
    _controller: ScheduledController,
    _env: Env,
    _ctx: ExecutionContext,
  ) {
    await rescheduleUpcomingMeetings()
  },
}
