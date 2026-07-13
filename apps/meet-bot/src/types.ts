export type JoinPayload = {
  meetingId: string
  meetLink: string
  displayName: string
  botRunId: string
  endsAtMs: number
  workflowInstanceId: string
  callbackBaseUrl: string
  callbackSecret: string
}

export type BotState =
  | 'idle'
  | 'joining'
  | 'waiting_admission'
  | 'joined'
  | 'recording'
  | 'leaving'
  | 'done'
  | 'failed'

export type BotStatus = {
  state: BotState
  meetingId: string | null
  botRunId: string | null
  errorMessage: string | null
  startedAt: number | null
}
