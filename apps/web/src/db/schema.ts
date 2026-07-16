import { relations, sql } from 'drizzle-orm'
import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' })
    .default(false)
    .notNull(),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
})

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .$onUpdate(() => new Date())
    .notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
})

/** Google OAuth tokens live here (Better Auth account table). */
export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', {
    mode: 'timestamp_ms',
  }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', {
    mode: 'timestamp_ms',
  }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .$onUpdate(() => new Date())
    .notNull(),
})

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
})

/** Calendar events that include a Google Meet link. */
export const meeting = sqliteTable(
  'meeting',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    googleEventId: text('google_event_id').notNull(),
    title: text('title').notNull(),
    meetLink: text('meet_link'),
    startsAt: integer('starts_at', { mode: 'timestamp_ms' }).notNull(),
    endsAt: integer('ends_at', { mode: 'timestamp_ms' }).notNull(),
    /** scheduled | cancelled | completed */
    status: text('status').notNull().default('scheduled'),
    htmlLink: text('html_link'),
    /** Cloudflare Workflow instance id (usually equals meeting id). */
    workflowInstanceId: text('workflow_instance_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('meeting_user_event_uidx').on(table.userId, table.googleEventId),
  ],
)

/**
 * Invitees from Google Calendar `attendees`.
 * These are people invited (with RSVP), NOT who actually joined the Meet.
 */
export const participant = sqliteTable(
  'participant',
  {
    id: text('id').primaryKey(),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meeting.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    displayName: text('display_name'),
    /** needsAction | declined | tentative | accepted */
    responseStatus: text('response_status'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('participant_meeting_email_uidx').on(
      table.meetingId,
      table.email,
    ),
  ],
)

/** Bot join attempts for a meeting (actual presence lives here later). */
export const botRun = sqliteTable('bot_run', {
  id: text('id').primaryKey(),
  meetingId: text('meeting_id')
    .notNull()
    .references(() => meeting.id, { onDelete: 'cascade' }),
  joinedAt: integer('joined_at', { mode: 'timestamp_ms' }),
  leftAt: integer('left_at', { mode: 'timestamp_ms' }),
  /**
   * pending | joining | waiting_admission | joined | left | failed
   */
  status: text('status').notNull().default('pending'),
  /** Nextcloud key for audio recording (.webm) */
  recordingKey: text('recording_key'),
  /** Nextcloud key for transcript (.txt) */
  transcriptKey: text('transcript_key'),
  /** Plain-text transcript for LLM / UI */
  transcriptText: text('transcript_text'),
  errorMessage: text('error_message'),
  workflowInstanceId: text('workflow_instance_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
})

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  meetings: many(meeting),
}))

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}))

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}))

export const participantRelations = relations(participant, ({ one }) => ({
  meeting: one(meeting, {
    fields: [participant.meetingId],
    references: [meeting.id],
  }),
}))

/** AI-generated notes for a bot run (summary + action items). */
export const meetingNotes = sqliteTable('meeting_notes', {
  id: text('id').primaryKey(),
  botRunId: text('bot_run_id')
    .notNull()
    .references(() => botRun.id, { onDelete: 'cascade' }),
  meetingId: text('meeting_id')
    .notNull()
    .references(() => meeting.id, { onDelete: 'cascade' }),
  /** pending | running | ready | failed */
  status: text('status').notNull().default('pending'),
  summaryText: text('summary_text'),
  /** JSON array of { text, assignee?, dueDate? } */
  actionItems: text('action_items'),
  errorMessage: text('error_message'),
  workflowInstanceId: text('workflow_instance_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
})

export const meetingRelations = relations(meeting, ({ one, many }) => ({
  user: one(user, {
    fields: [meeting.userId],
    references: [user.id],
  }),
  participants: many(participant),
  botRuns: many(botRun),
  notes: many(meetingNotes),
}))

export const botRunRelations = relations(botRun, ({ one, many }) => ({
  meeting: one(meeting, {
    fields: [botRun.meetingId],
    references: [meeting.id],
  }),
  notes: many(meetingNotes),
}))

export const meetingNotesRelations = relations(meetingNotes, ({ one }) => ({
  botRun: one(botRun, {
    fields: [meetingNotes.botRunId],
    references: [botRun.id],
  }),
  meeting: one(meeting, {
    fields: [meetingNotes.meetingId],
    references: [meeting.id],
  }),
}))
