import type { ClassValue } from 'clsx'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function startOfLocalDay(date: Date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

export function addDays(date: Date, days: number) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

export function isSameLocalDay(a: Date | string, b: Date) {
  const left = a instanceof Date ? a : new Date(a)
  if (Number.isNaN(left.getTime())) return false
  return (
    left.getFullYear() === b.getFullYear() &&
    left.getMonth() === b.getMonth() &&
    left.getDate() === b.getDate()
  )
}

export function formatDayLabel(date: Date) {
  const today = startOfLocalDay(new Date())
  const tomorrow = addDays(today, 1)
  const yesterday = addDays(today, -1)
  const day = startOfLocalDay(date)

  if (day.getTime() === today.getTime()) return 'Today'
  if (day.getTime() === tomorrow.getTime()) return 'Tomorrow'
  if (day.getTime() === yesterday.getTime()) return 'Yesterday'

  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

type FormatWhenStyle = 'time' | 'datetime'

const FORMAT_WHEN_OPTIONS: Record<FormatWhenStyle, Intl.DateTimeFormatOptions> =
  {
    time: {
      hour: 'numeric',
      minute: '2-digit',
    },
    datetime: {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    },
  }

export function formatWhen(
  value: Date | string | null | undefined,
  style: FormatWhenStyle = 'time',
) {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString(undefined, FORMAT_WHEN_OPTIONS[style])
}

export function formatDuration(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—'
  const totalSec = Math.round(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function botTimeline(status: string | undefined) {
  const steps = [
    'pending',
    'joining',
    'waiting_admission',
    'joined',
    'left',
  ] as const
  if (!status) {
    return steps.map((s) => ({ id: s, done: false, current: false }))
  }
  if (status === 'failed') {
    return [
      ...steps.slice(0, 3).map((s) => ({ id: s, done: true, current: false })),
      { id: 'failed', done: true, current: true },
    ]
  }
  const idx = steps.indexOf(status as (typeof steps)[number])
  return steps.map((s, i) => ({
    id: s,
    done: idx >= 0 && i <= idx,
    current: s === status,
  }))
}
