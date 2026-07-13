import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import path from 'node:path'

import type { JoinPayload } from './types.js'

export class AudioRecorder {
  private process: ChildProcess | null = null
  private readonly outputPath: string

  constructor(botRunId: string) {
    this.outputPath = path.join('/tmp', `recording-${botRunId}.webm`)
  }

  get path() {
    return this.outputPath
  }

  start() {
    if (this.process) return

    // Capture the PulseAudio monitor of the virtual Meet sink.
    this.process = spawn(
      'ffmpeg',
      [
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
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )

    this.process.stderr?.on('data', (chunk) => {
      const text = String(chunk)
      if (text.toLowerCase().includes('error')) {
        console.error('[ffmpeg]', text.trim())
      }
    })
  }

  async stop(): Promise<string | null> {
    if (!this.process) return null

    const proc = this.process
    this.process = null

    await new Promise<void>((resolve) => {
      proc.once('close', () => resolve())
      proc.kill('SIGINT')
      setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          // ignore
        }
        resolve()
      }, 5000)
    })

    return this.outputPath
  }

  async upload(payload: JoinPayload, status: 'left' | 'failed', errorMessage?: string) {
    const form = new FormData()
    form.set('botRunId', payload.botRunId)
    form.set('meetingId', payload.meetingId)
    form.set('workflowInstanceId', payload.workflowInstanceId)
    form.set('status', status)
    if (errorMessage) form.set('errorMessage', errorMessage)

    try {
      const stream = createReadStream(this.outputPath)
      const chunks: Buffer[] = []
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      const blob = new Blob([Buffer.concat(chunks)], { type: 'audio/webm' })
      form.set('recording', blob, `${payload.botRunId}.webm`)
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
