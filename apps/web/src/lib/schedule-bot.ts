import { env } from 'cloudflare:workers'

import type { MeetingBotParams } from '#/workflows/meeting-bot'

const TERMINAL = new Set(['complete', 'terminated', 'errored'])

/** Stable Workflow instance id per meeting (first schedule). */
export function workflowInstanceIdForMeeting(meetingId: string) {
  return meetingId
}

async function readStatus(instanceId: string) {
  try {
    const instance = await env.MEETING_BOT_WORKFLOW.get(instanceId)
    return await instance.status()
  } catch {
    return null
  }
}

async function terminateIfRunning(instanceId: string) {
  const status = await readStatus(instanceId)
  if (!status) return
  if (TERMINAL.has(status.status)) return
  try {
    const instance = await env.MEETING_BOT_WORKFLOW.get(instanceId)
    await instance.terminate()
  } catch {
    // ignore
  }
}

/**
 * Create or replace the MeetingBotWorkflow for a scheduled Meet.
 * Cancelled / completed meetings terminate any running instance.
 * Errored / finished instances get a new id (CF IDs are one-shot).
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
  const baseId = workflowInstanceIdForMeeting(input.meetingId)
  const wakeAt = new Date(
    Math.max(Date.now(), input.startsAt.getTime() - 5 * 60 * 1000),
  )

  if (input.status !== 'scheduled' || !input.meetLink) {
    console.log(
      `[workflow] skip/terminate meeting=${input.meetingId} status=${input.status}`,
    )
    if (input.previousWorkflowInstanceId) {
      await terminateIfRunning(input.previousWorkflowInstanceId)
    }
    await terminateIfRunning(baseId)
    return null
  }

  const previousId = input.previousWorkflowInstanceId
  const previousStatus = previousId ? await readStatus(previousId) : null

  const scheduleChanged =
    input.previousStartsAtMs !== undefined &&
    (input.previousStartsAtMs !== input.startsAt.getTime() ||
      input.previousMeetLink !== input.meetLink)

  const previousDead =
    !previousId ||
    !previousStatus ||
    TERMINAL.has(previousStatus.status)

  const needsCreate = previousDead || scheduleChanged

  if (!needsCreate && previousId) {
    console.log(
      `[workflow] already scheduled meeting=${input.meetingId} id=${previousId} status=${previousStatus?.status} wakeAt=${wakeAt.toISOString()}`,
    )
    return previousId
  }

  if (previousId) {
    await terminateIfRunning(previousId)
  }

  // CF workflow instance ids are unique forever — use a fresh id after errors/resyncs.
  const instanceId = previousDead || scheduleChanged
    ? `${baseId}-${Date.now()}`
    : baseId

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

  console.log(
    `[workflow] created meeting=${input.meetingId} id=${instanceId} reason=${previousDead ? previousStatus?.status ?? 'missing' : 'schedule-changed'} startsAt=${input.startsAt.toISOString()} wakeAt=${wakeAt.toISOString()}`,
  )

  return instanceId
}

/** Live Workflow instance status for UI / debugging. */
export async function getWorkflowStatus(instanceId: string | null | undefined) {
  if (!instanceId) return null
  try {
    const instance = await env.MEETING_BOT_WORKFLOW.get(instanceId)
    const status = await instance.status()
    return {
      id: instanceId,
      status: status.status,
      error: status.error ?? null,
    }
  } catch {
    return { id: instanceId, status: 'missing' as const, error: null }
  }
}
