import { desc, eq } from 'drizzle-orm'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db'
import { botRun } from '#/db/schema'
import type { MeetingBotParams } from '#/workflows/meeting-bot'

const TERMINAL = new Set(['complete', 'terminated', 'errored'])
const STUCK_JOIN_MS = 2 * 60 * 1000

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

/** True if an in-progress meeting's bot never got into the call / failed. */
async function isBotStuckOrFailed(meetingId: string, startsAt: Date) {
  const latest = await getDb().query.botRun.findFirst({
    where: eq(botRun.meetingId, meetingId),
    orderBy: [desc(botRun.createdAt)],
  })

  if (!latest) {
    // Meeting already started (or past T-5) but no bot run → launch never stuck a row, or old data
    return Date.now() >= startsAt.getTime() - 5 * 60 * 1000
  }

  if (latest.status === 'failed') return true
  if (latest.status === 'joined' || latest.status === 'left') return false

  // pending / joining / waiting_admission too long after wake time
  const wakeAt = startsAt.getTime() - 5 * 60 * 1000
  if (Date.now() < wakeAt + STUCK_JOIN_MS) return false

  return (
    latest.status === 'pending' ||
    latest.status === 'joining' ||
    latest.status === 'waiting_admission'
  )
}

/**
 * Create or replace the MeetingBotWorkflow for a scheduled Meet.
 * Cancelled / completed meetings terminate any running instance.
 * Errored / stuck / finished instances get a new id (CF IDs are one-shot).
 *
 * In-progress meetings: wakeAt = now → join immediately (no wait for wall clock).
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
  const inProgress =
    Date.now() >= input.startsAt.getTime() && Date.now() < input.endsAt.getTime()

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

  // Bot already finished successfully — do not spawn another join on every page refresh
  const latestRun = await getDb().query.botRun.findFirst({
    where: eq(botRun.meetingId, input.meetingId),
    orderBy: [desc(botRun.createdAt)],
  })
  if (latestRun?.status === 'left') {
    console.log(
      `[workflow] skip meeting=${input.meetingId} — bot already completed (left)`,
    )
    return input.previousWorkflowInstanceId ?? null
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

  const stuck =
    !previousDead &&
    (await isBotStuckOrFailed(input.meetingId, input.startsAt))

  const needsCreate = previousDead || scheduleChanged || stuck

  if (!needsCreate && previousId) {
    console.log(
      `[workflow] already scheduled meeting=${input.meetingId} id=${previousId} status=${previousStatus?.status} inProgress=${inProgress} wakeAt=${wakeAt.toISOString()}`,
    )
    return previousId
  }

  if (previousId) {
    await terminateIfRunning(previousId)
  }

  const reason = scheduleChanged
    ? 'schedule-changed'
    : stuck
      ? 'stuck-or-failed-rejoin'
      : (previousStatus?.status ?? 'missing')

  // CF workflow instance ids are unique forever — use a fresh id after errors/resyncs.
  const instanceId = `${baseId}-${Date.now()}`

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
    `[workflow] created meeting=${input.meetingId} id=${instanceId} reason=${reason} inProgress=${inProgress} startsAt=${input.startsAt.toISOString()} wakeAt=${wakeAt.toISOString()}`,
  )

  return instanceId
}

/** Live Workflow instance status for UI / debugging. */
export type WorkflowUiStatus = {
  id: string
  status: string
  error: unknown
}

export function formatWorkflowError(error: unknown): string | null {
  if (error == null) return null
  if (typeof error === 'string') return error
  return JSON.stringify(error)
}

export async function getWorkflowStatus(
  instanceId: string | null | undefined,
): Promise<WorkflowUiStatus | null> {
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
