import { spawn, type Subprocess } from 'bun'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from 'puppeteer-core'

import type { JoinPayload } from './types.ts'

function log(...args: unknown[]) {
  console.log(`[recorder ${new Date().toISOString()}]`, ...args)
}

/**
 * Prefer in-page MediaRecorder (captures Meet WebRTC audio on Mac/CDP).
 * Fall back to ffmpeg Pulse (Docker) or avfoundation/BlackHole (Mac).
 */
export class AudioRecorder {
  private process: Subprocess | null = null
  private page: Page | null = null
  private mode: 'browser' | 'ffmpeg' | null = null
  private readonly outputPath: string

  constructor(botRunId: string) {
    this.outputPath = path.join('/tmp', `recording-${botRunId}.webm`)
  }

  async hasAudioFile(): Promise<boolean> {
    try {
      const file = Bun.file(this.outputPath)
      return (await file.exists()) && file.size > 0
    } catch {
      return false
    }
  }

  async start(page?: Page | null) {
    if (this.mode) return

    this.page = page ?? null
    const forceFfmpeg = process.env.BOT_RECORD_MODE === 'ffmpeg'
    const forceBrowser = process.env.BOT_RECORD_MODE === 'browser'
    const useBrowser =
      forceBrowser ||
      (!forceFfmpeg &&
        Boolean(this.page) &&
        (Boolean(process.env.BOT_CDP_URL) || process.platform === 'darwin'))

    if (useBrowser && this.page) {
      const started = await this.startBrowserCapture(this.page)
      if (started) {
        this.mode = 'browser'
        log('browser MediaRecorder started →', this.outputPath)
        return
      }
      log('browser capture unavailable — falling back to ffmpeg')
    }

    this.startFfmpeg()
    this.mode = 'ffmpeg'
  }

  private async startBrowserCapture(page: Page): Promise<boolean> {
    for (let attempt = 0; attempt < 15; attempt++) {
      const ok = await page.evaluate(() => {
        const w = window as unknown as {
          __meetBotRecorder?: MediaRecorder
          __meetBotChunks?: Blob[]
        }
        if (w.__meetBotRecorder?.state === 'recording') return true

        const stream = new MediaStream()
        for (const el of Array.from(document.querySelectorAll('audio, video'))) {
          const ms = (el as HTMLMediaElement).srcObject
          if (!(ms instanceof MediaStream)) continue
          for (const track of ms.getAudioTracks()) {
            if (track.readyState !== 'live') continue
            if (!stream.getAudioTracks().some((t) => t.id === track.id)) {
              stream.addTrack(track)
            }
          }
        }
        if (stream.getAudioTracks().length === 0) return false

        const mimeType = MediaRecorder.isTypeSupported(
          'audio/webm;codecs=opus',
        )
          ? 'audio/webm;codecs=opus'
          : 'audio/webm'
        const chunks: Blob[] = []
        const recorder = new MediaRecorder(stream, { mimeType })
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data)
        }
        w.__meetBotChunks = chunks
        w.__meetBotRecorder = recorder
        recorder.start(1000)
        return true
      })
      if (ok) return true
      await Bun.sleep(1000)
    }
    return false
  }

  private startFfmpeg() {
    if (this.process) return

    const cmd =
      process.platform === 'darwin'
        ? [
            'ffmpeg',
            '-y',
            '-f',
            'avfoundation',
            '-i',
            `:${process.env.BOT_AUDIO_DEVICE || 'BlackHole 2ch'}`,
            '-c:a',
            'libopus',
            '-b:a',
            '64k',
            this.outputPath,
          ]
        : [
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
          ]

    log('ffmpeg start', cmd.join(' '))
    this.process = spawn({
      cmd,
      stdout: 'ignore',
      stderr: 'pipe',
    })
  }

  async stop(): Promise<string | null> {
    if (this.mode === 'browser' && this.page) {
      try {
        const bytes = await this.page.evaluate(async () => {
          const w = window as unknown as {
            __meetBotRecorder?: MediaRecorder
            __meetBotChunks?: Blob[]
          }
          const recorder = w.__meetBotRecorder
          const chunks = w.__meetBotChunks
          if (!recorder || !chunks) return null

          await new Promise<void>((resolve) => {
            recorder.onstop = () => resolve()
            if (recorder.state === 'recording') recorder.stop()
            else resolve()
          })

          const blob = new Blob(chunks, { type: 'audio/webm' })
          if (blob.size === 0) return null
          const buf = new Uint8Array(await blob.arrayBuffer())
          return Array.from(buf)
        })

        if (bytes && bytes.length > 0) {
          await Bun.write(this.outputPath, new Uint8Array(bytes))
          log(
            `browser recording saved (${bytes.length} bytes) → ${this.outputPath}`,
          )
        } else {
          log('browser recording empty')
        }
      } catch (error) {
        log('browser stop failed', error)
      }
      this.mode = null
      this.page = null
      return this.outputPath
    }

    if (!this.process) {
      this.mode = null
      return null
    }

    const proc = this.process
    this.process = null
    this.mode = null
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
    attendees?: Array<{
      name: string
      email?: string | null
      firstSeenAt?: string
      lastSeenAt?: string
      leftDuringCall?: boolean
    }>,
    overview?: {
      leaveReason?: string
      durationMs?: number
      uniqueAttendeeCount?: number
    },
  ) {
    const form = new FormData()
    form.set('botRunId', payload.botRunId)
    form.set('meetingId', payload.meetingId)
    form.set('workflowInstanceId', payload.workflowInstanceId)
    form.set('status', status)
    if (errorMessage) form.set('errorMessage', errorMessage)
    if (attendees && attendees.length > 0) {
      form.set('attendees', JSON.stringify(attendees))
    }
    if (overview?.leaveReason) form.set('leaveReason', overview.leaveReason)
    if (overview?.durationMs != null) {
      form.set('durationMs', String(overview.durationMs))
    }
    if (overview?.uniqueAttendeeCount != null) {
      form.set('uniqueAttendeeCount', String(overview.uniqueAttendeeCount))
    }

    let hadFile = false
    try {
      const file = Bun.file(this.outputPath)
      if (await file.exists()) {
        const size = file.size
        if (size > 0) {
          form.set('recording', file, `${payload.botRunId}.webm`)
          hadFile = true
          log(`uploading recording ${size} bytes`)
        } else {
          log('recording file empty — complete without audio')
        }
      } else {
        log('no recording file — complete without audio')
      }
    } catch {
      // Recording file may be missing on early failure.
    }

    const response = await fetch(`${payload.callbackBaseUrl}/api/bot/complete`, {
      method: 'POST',
      headers: { 'x-bot-secret': payload.callbackSecret },
      body: form,
    })

    const text = await response.text()
    if (!response.ok) {
      throw new Error(`Complete callback failed (${response.status}): ${text}`)
    }

    let recordingKey: string | null = null
    let recordingUrl: string | null = null
    let transcriptKey: string | null = null
    let transcriptUrl: string | null = null
    try {
      const json = JSON.parse(text) as {
        recordingKey?: string | null
        recordingUrl?: string | null
        transcriptKey?: string | null
        transcriptUrl?: string | null
        transcriptPreview?: string | null
      }
      recordingKey = json.recordingKey ?? null
      recordingUrl = json.recordingUrl ?? null
      transcriptKey = json.transcriptKey ?? null
      transcriptUrl = json.transcriptUrl ?? null
      if (json.transcriptPreview) {
        console.log(
          `[recorder] transcript preview: ${json.transcriptPreview}`,
        )
      }
    } catch {
      // non-JSON ok
    }

    log(
      `complete ok hadFile=${hadFile} audio=${recordingKey ?? 'none'} transcript=${transcriptKey ?? 'none'}`,
    )
    if (recordingUrl) {
      console.log(`[recorder] Nextcloud audio: ${recordingUrl}`)
    }
    if (transcriptUrl) {
      console.log(`[recorder] Nextcloud transcript: ${transcriptUrl}`)
    } else if (recordingKey) {
      console.log(`[recorder] Nextcloud audio key: ${recordingKey}`)
    }

    try {
      await unlink(this.outputPath)
    } catch {
      // ignore
    }
  }
}
