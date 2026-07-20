import { useMemo } from 'react'
import { Link } from '@tanstack/react-router'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table'
import {
  ChevronDown,
  Eye,
  MoreHorizontal,
  Play,
  Square,
} from 'lucide-react'

import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '#/components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import type { MeetingWithParticipants } from '#/lib/calendar'
import { formatWhen } from '#/lib/utils'

const ACTIVE_WORKFLOW = new Set(['queued', 'running', 'waiting', 'paused'])

function isBotScheduled(item: MeetingWithParticipants) {
  if (!item.workflowInstanceId) return false
  if (!item.workflowStatus || item.workflowStatus === 'missing') return false
  return ACTIVE_WORKFLOW.has(item.workflowStatus)
}

export function scheduleBadge(item: MeetingWithParticipants): {
  label: string
  variant: 'default' | 'secondary' | 'destructive' | 'outline'
} {
  const run = item.latestBotRun
  if (run?.status === 'joined' || run?.status === 'joining') {
    return { label: 'Bot in call', variant: 'default' }
  }
  if (run?.status === 'waiting_admission') {
    return { label: 'Waiting admission', variant: 'default' }
  }
  if (run?.status === 'left') {
    return {
      label:
        run.transcriptKey || run.transcriptText
          ? 'Completed · transcript ready'
          : run.recordingKey
            ? 'Completed · audio saved'
            : 'Completed',
      variant: 'secondary',
    }
  }
  if (run?.status === 'failed' || item.workflowStatus === 'errored') {
    return {
      label: `Failed${run?.errorMessage ? ` · ${run.errorMessage}` : ''}`,
      variant: 'destructive',
    }
  }
  if (isBotScheduled(item)) {
    const wake =
      item.botWakeAt && !Number.isNaN(new Date(item.botWakeAt).getTime())
        ? formatWhen(item.botWakeAt)
        : null
    return {
      label: wake ? `Scheduled · joins ~${wake}` : 'Scheduled',
      variant: 'default',
    }
  }
  return { label: 'Not scheduled', variant: 'outline' }
}

export function canStopBot(item: MeetingWithParticipants) {
  if (isBotScheduled(item)) return true
  const run = item.latestBotRun
  return (
    run?.status === 'pending' ||
    run?.status === 'joining' ||
    run?.status === 'waiting_admission' ||
    run?.status === 'joined'
  )
}

export function canScheduleBot(item: MeetingWithParticipants) {
  if (!item.meetLink) return false
  const endsAt = new Date(item.endsAt).getTime()
  const graceMs = 4 * 60 * 60 * 1000
  const joinableWindow =
    item.status === 'scheduled' ||
    (item.status === 'completed' && Date.now() < endsAt + graceMs)
  if (!joinableWindow) return false
  if (isBotScheduled(item)) return false
  const run = item.latestBotRun
  if (
    run?.status === 'joining' ||
    run?.status === 'waiting_admission' ||
    run?.status === 'joined' ||
    run?.status === 'left'
  ) {
    return false
  }
  return true
}

type MeetingsTableMeta = {
  schedulingId: string | null
  stoppingId: string | null
  onScheduleBot: (meetingId: string) => void
  onStopBot: (meetingId: string) => void
  showActions: boolean
}

function InviteesCell({ item }: { item: MeetingWithParticipants }) {
  if (item.participants.length === 0) {
    return <span className="text-muted-foreground">—</span>
  }

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-left text-muted-foreground hover:text-foreground [&[data-state=open]>svg]:rotate-180">
        <ChevronDown className="size-3.5 shrink-0 transition-transform" />
        {item.participants.length} invitee
        {item.participants.length === 1 ? '' : 's'}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-2 max-w-72 space-y-1 text-xs text-muted-foreground whitespace-normal">
          {item.participants.map((p) => (
            <li key={`${item.id}-${p.email}`}>
              {p.displayName ?? p.email}
              {p.responseStatus ? ` · ${p.responseStatus}` : ''}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

function RowActionsMenu({
  item,
  meta,
}: {
  item: MeetingWithParticipants
  meta: MeetingsTableMeta
}) {
  const busy = meta.schedulingId === item.id || meta.stoppingId === item.id
  const showSchedule = meta.showActions && canScheduleBot(item)
  const showStop = meta.showActions && canStopBot(item)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="size-8 p-0"
          disabled={busy}
          aria-label="Open actions"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem asChild>
          <Link to="/meeting/$meetingId" params={{ meetingId: item.id }}>
            <Eye />
            Details
          </Link>
        </DropdownMenuItem>
        {showSchedule || showStop ? <DropdownMenuSeparator /> : null}
        {showSchedule ? (
          <DropdownMenuItem
            disabled={busy}
            onClick={() => meta.onScheduleBot(item.id)}
          >
            <Play />
            {meta.schedulingId === item.id ? 'Scheduling…' : 'Schedule bot'}
          </DropdownMenuItem>
        ) : null}
        {showStop ? (
          <DropdownMenuItem
            variant="destructive"
            disabled={busy}
            onClick={() => meta.onStopBot(item.id)}
          >
            <Square />
            {meta.stoppingId === item.id ? 'Stopping…' : 'Stop bot'}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function createColumns(): ColumnDef<MeetingWithParticipants>[] {
  return [
    {
      id: 'title',
      header: 'Meeting',
      cell: ({ row }) => {
        const item = row.original
        return (
          <div className="min-w-56 max-w-md space-y-1.5 whitespace-normal">
            <Link
              to="/meeting/$meetingId"
              params={{ meetingId: item.id }}
              className="font-medium hover:underline"
            >
              {item.title}
            </Link>
            {item.meetLink ? (
              <a
                href={item.meetLink}
                target="_blank"
                rel="noreferrer"
                className="block text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                Join Meet
              </a>
            ) : null}
          </div>
        )
      },
    },
    {
      id: 'when',
      header: 'When',
      cell: ({ row }) => (
        <span className="tabular-nums text-muted-foreground">
          {formatWhen(row.original.startsAt)} – {formatWhen(row.original.endsAt)}
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: ({ row }) => {
        const badge = scheduleBadge(row.original)
        return (
          <div className="min-w-40 space-y-1.5 whitespace-normal">
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {row.original.workflowError ? (
              <p className="max-w-56 text-xs text-destructive">
                {row.original.workflowError}
              </p>
            ) : null}
          </div>
        )
      },
    },
    {
      id: 'invitees',
      header: 'Invitees',
      cell: ({ row }) => <InviteesCell item={row.original} />,
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row, table }) => (
        <div className="flex justify-end">
          <RowActionsMenu
            item={row.original}
            meta={table.options.meta as MeetingsTableMeta}
          />
        </div>
      ),
    },
  ]
}

export function MeetingsDataTable({
  data,
  emptyMessage,
  showActions = true,
  schedulingId = null,
  stoppingId = null,
  onScheduleBot,
  onStopBot,
}: {
  data: MeetingWithParticipants[]
  emptyMessage: string
  showActions?: boolean
  schedulingId?: string | null
  stoppingId?: string | null
  onScheduleBot?: (meetingId: string) => void
  onStopBot?: (meetingId: string) => void
}) {
  const columns = useMemo(() => createColumns(), [])

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    meta: {
      schedulingId,
      stoppingId,
      onScheduleBot: onScheduleBot ?? (() => {}),
      onStopBot: onStopBot ?? (() => {}),
      showActions,
    } satisfies MeetingsTableMeta,
  })

  if (data.length === 0) {
    return (
      <p className="mt-6 text-sm text-muted-foreground">{emptyMessage}</p>
    )
  }

  return (
    <div className="mt-6 w-full border border-border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id} className="h-12 px-4 text-xs">
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id} className="px-4 py-4">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
