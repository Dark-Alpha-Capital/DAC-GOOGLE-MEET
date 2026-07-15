import { spawn, type Subprocess } from 'bun'
import { unlink } from 'node:fs/promises'
import path from 'node:path'

import type { JoinPayload } from './types.ts'

export class AudioRecorder {
  private process: Subprocess | null = null
  private readonly outputPath: string

  constructor(botRunId: string) {
    this.outputPath = path.join('/tmp', `recording-${botRunId}.webm`)
  }

  start() {
    if (this.process) return

    this.process = spawn({
      cmd: [
        'ffmpeg',
        '-y',
        '-f',
        'pulse',
        '-i',
        'meet_sink.monitor',
        '-c:a',
        'libopus',
        '-b:a',
        '64k',
        this.outputPath,
      ],
      stdout: 'ignore',
      stderr: 'pipe',
    })
  }

  async stop(): Promise<string | null> {
    if (!this.process) return null

    const proc = this.process
    this.process = null
    proc.kill('SIGINT')

    const deadline = Date.now() + 5000
    while (proc.exitCode === null && Date.now() < deadline) {
      await Bun.sleep(100)
    }
    if (proc.exitCode === null) proc.kill('SIGKILL')

    return this.outputPath
  }

  async upload(
    payload: JoinPayload,
    status: 'left' | 'failed',
    errorMessage?: string,
  ) {
    const form = new FormData()
    form.set('botRunId', payload.botRunId)
    form.set('meetingId', payload.meetingId)
    form.set('workflowInstanceId', payload.workflowInstanceId)
    form.set('status', status)
    if (errorMessage) form.set('errorMessage', errorMessage)

    try {
      const file = Bun.file(this.outputPath)
      if (await file.exists()) {
        form.set('recording', file, `${payload.botRunId}.webm`)
      }
    } catch {
      // Recording file may be missing on early failure.
    }

    const response = await fetch(`${payload.callbackBaseUrl}/api/bot/complete`, {
      method: 'POST',
      headers: { 'x-bot-secret': payload.callbackSecret },
      body: form,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Complete callback failed (${response.status}): ${text}`)
    }

    try {
      await unlink(this.outputPath)
    } catch {
      // ignore
    }
  }
}
