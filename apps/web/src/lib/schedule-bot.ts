import { env } from 'cloudflare:workers'

import type { MeetingBotParams } from '#/workflows/meeting-bot'

/** Stable Workflow instance id per meeting. */
export function workflowInstanceIdForMeeting(meetingId: string) {
  return meetingId
}

async function terminateIfExists(instanceId: string) {
  try {
    const instance = await env.MEETING_BOT_WORKFLOW.get(instanceId)
    const status = await instance.status()
    if (
      status.status === 'complete' ||
      status.status === 'terminated' ||
      status.status === 'errored'
    ) {
      return
    }
    await instance.terminate()
  } catch {
    // Instance may not exist yet.
  }
}

/**
 * Create or replace the MeetingBotWorkflow for a scheduled Meet.
 * Cancelled / completed meetings terminate any running instance.
 */
export async function scheduleMeetingBot(input: {
  meetingId: string
  meetLink: string | null
  startsAt: Date
  endsAt: Date
  status: string
  previousStartsAtMs?: number
  previousMeetLink?: string | null
  previousWorkflowInstanceId?: string | null
}): Promise<string | null> {
  const instanceId = workflowInstanceIdForMeeting(input.meetingId)

  if (input.status !== 'scheduled' || !input.meetLink) {
    await terminateIfExists(instanceId)
    return null
  }

  const scheduleChanged =
    input.previousStartsAtMs !== undefined &&
    (input.previousStartsAtMs !== input.startsAt.getTime() ||
      input.previousMeetLink !== input.meetLink)

  const needsCreate =
    !input.previousWorkflowInstanceId ||
    scheduleChanged ||
    input.previousWorkflowInstanceId !== instanceId

  if (!needsCreate) {
    return input.previousWorkflowInstanceId ?? null
  }

  await terminateIfExists(instanceId)

  const params: MeetingBotParams = {
    meetingId: input.meetingId,
    meetLink: input.meetLink,
    startsAtMs: input.startsAt.getTime(),
    endsAtMs: input.endsAt.getTime(),
    displayName: env.BOT_DISPLAY_NAME || 'DAC Notetaker',
  }

  await env.MEETING_BOT_WORKFLOW.create({
    id: instanceId,
    params,
  })

  return instanceId
}
