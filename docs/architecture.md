# Architecture

## Goal

**dac-googlemeet** is an automated meeting recording system. The high-level goal is to eliminate the manual overhead of joining and recording Google Meet calls. A user signs in with their Google account, the system discovers every calendar event with a Meet link, and a headless bot joins each meeting as a guest, records the audio, and uploads the result to self-hosted Nextcloud storage.

No one needs to remember to hit "record". No one needs to attend just to capture the call. The recording is waiting in Nextcloud after the meeting ends.

---

## System overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         CLOUDFLARE WORKERS                           │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │                  apps/web (TanStack Start)                       │ │
│  │                                                                  │ │
│  │  ┌──────────┐   ┌──────────────┐   ┌───────────────────────────┐│ │
│  │  │  React   │   │  Server Fns  │   │     API Routes            ││ │
│  │  │  Pages   │   │  (RPC-style) │   │                           ││ │
│  │  │          │   │              │   │  /api/auth/$   (BetterAuth)││ │
│  │  │  /       │   │  syncMeetings│   │  /api/bot/status           ││ │
│  │  │  /login  │   │  getStoredX  │   │  /api/bot/complete        ││ │
│  │  │          │   │  getSession  │   │                           ││ │
│  │  └──────────┘   └──────┬───────┘   └───────────┬───────────────┘│ │
│  │                        │                        │                │ │
│  │  ┌─────────────────────┼────────────────────────┼──────────────┐ │ │
│  │  │              Cloudflare D1 (SQLite)           │              │ │ │
│  │  │  user | session | account | verification |    │              │ │ │
│  │  │  meeting | participant | bot_run              │              │ │ │
│  │  └──────────────────────────────────────────────────────────────┘ │ │
│  │                                                                  │ │
│  │  ┌──────────────────────┐  ┌────────────────────────────────────┐│ │
│  │  │ MeetingBotWorkflow   │  │  MeetBotContainer                  ││ │
│  │  │ (Cloudflare          │  │  (Durable Object + Docker)         ││ │
│  │  │  Workflows)          │  │                                    ││ │
│  │  │                      │  │  ┌──────────────────────────────┐  ││ │
│  │  │ 1. Prepare (DB)      │  │  │  apps/meet-bot (Bun server)  │  ││ │
│  │  │ 2. Sleep until T-5m  │──┼──│  - POST /join  → Puppeteer  │  ││ │
│  │  │ 3. Launch container  │  │  │  - POST /stop                │  ││ │
│  │  │ 4. Wait for event    │  │  │  - GET /health                │  ││ │
│  │  │ 5. Finalize          │  │  │                                │  ││ │
│  │  └──────────────────────┘  │  │  Chromium + ffmpeg + PulseAudio │  ││ │
│  │                             │  └──────────────────────────────┘  ││ │
│  │                             └────────────────────────────────────┘│ │
│  │                                                                  │ │
│  │  ┌──────────────────────────────────────────────────────────────┐│ │
│  │  │  @repo/storage (Nextcloud WebDAV)                            ││ │
│  │  │  PUT /remote.php/dav/files/{user}/dac-googlemeet/{key}       ││ │
│  │  └──────────────────────────────────────────────────────────────┘│ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  External:                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────────┐│
│  │ Google OAuth  │  │ Google Cal API│  │ Nextcloud (WebDAV storage)  ││
│  └──────────────┘  └──────────────┘  └──────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────┘
```

---

## Components

### apps/web — Dashboard (TanStack Start + Cloudflare Workers)

The entry point for users. Deployed as a Cloudflare Worker (`dac-google-meet`).

- **Framework**: TanStack Start v1 (Vite 8, React 19, SSR)
- **Routing**: TanStack Router, file-based under `src/routes/`. The route tree is code-generated via `tsr generate`.
- **Auth**: Better Auth v1.5 with Google OAuth and D1 adapter. The auth endpoint (`/api/auth/$`) is a catch-all that forwards to Better Auth's handler. The `tanstackStartCookies` plugin wires session cookies into TanStack Start.
- **Database**: Drizzle ORM over Cloudflare D1 (SQLite). Seven tables: `user`, `session`, `account`, `verification`, `meeting`, `participant`, `bot_run`.
- **Server functions**: TanStack Start `createServerFn` provides RPC-style calls from client to server — `syncMeetingsFromCalendar`, `getStoredMeetings`, `getSession`.
- **Secrets**: All sensitive values are stored as Wrangler secrets (`BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BOT_INTERNAL_SECRET`, Nextcloud credentials). Never in `.env` files.

**Key files**:
| File | Purpose |
|------|---------|
| `src/server.ts` | Worker entry point; exports container + workflow classes |
| `src/db/schema.ts` | Drizzle ORM schema (7 tables with relations) |
| `src/db/index.ts` | `getDb()` — returns Drizzle instance bound to `env.DB` |
| `src/lib/auth.ts` | Better Auth server config (Google OAuth, D1 adapter, cookie plugin) |
| `src/lib/auth-client.ts` | Better Auth client-side React hook |
| `src/lib/session.ts` | `getSession()` server fn — returns current session |
| `src/lib/calendar.ts` | `syncMeetingsFromCalendar()` + `getStoredMeetings()` server fns |
| `src/lib/schedule-bot.ts` | `scheduleMeetingBot()` — creates/replaces Cloudflare Workflows |
| `src/lib/storage.ts` | `getStorage()` — singleton Nextcloud adapter from Wrangler secrets |
| `src/workflows/meeting-bot.ts` | `MeetingBotWorkflow` class — 5-step lifecycle |
| `src/containers/meet-bot.ts` | `MeetBotContainer` class — Durable Object managing the Docker container |

### apps/meet-bot — Bot container (Bun + Puppeteer + Chromium)

A standalone Bun HTTP server that runs inside a Cloudflare Container (Docker). It receives a `POST /join` with meeting details, launches Chromium via Puppeteer, joins the Google Meet, and records audio.

- **Runtime**: Bun on Debian (Docker base: `oven/bun:1.2-debian`)
- **Browser**: Puppeteer-core + system Chromium (`/usr/bin/chromium`)
- **Audio**: PulseAudio null sink (`meet_sink`) → ffmpeg (libopus, 64kbps) → `/tmp/recording-{botRunId}.webm`
- **Anti-detection**: Puppeteer-extra stealth plugin (planned), `--disable-blink-features=AutomationControlled`, overwrites `navigator.webdriver`, fake media device IDs, headed on macOS / headless in Docker

**Endpoints**:
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Container health check (`{ ok: true }`) |
| `GET` | `/status` | Returns current bot state |
| `POST` | `/join` | Receives `JoinPayload`, starts bot asynchronously, returns `202` |
| `POST` | `/stop` | Requests bot to leave meeting and close browser |

### packages/storage — Nextcloud WebDAV client (`@repo/storage`)

A pure-fetch WebDAV client compatible with Cloudflare Workers (no `node:` dependencies). Used by the web app to store recordings on a self-hosted Nextcloud instance.

**API**: `createNextcloudStorage(config)` → `StorageAdapter { put, exists, delete }`

- **put(key, body, options?)**: Uploads file to `{url}/remote.php/dav/files/{user}/{rootPath}/{key}`. Automatically creates intermediate directories with `MKCOL`.
- **exists(key)**: `PROPFIND` Depth: 0
- **delete(key)**: `DELETE`

Auth is HTTP Basic over HTTPS. The root path defaults to `dac-googlemeet`.

### Supporting packages

- **@repo/eslint-config**: Shared ESLint flat config (`base.js` converts all errors to warnings)
- **@repo/typescript-config**: Shared tsconfig presets (`base.json`, `nextjs.json`, `react-library.json`)
- **@repo/ui**: Stub React component library (not actively used)
- **apps/server**: Empty stub (unused)

---

## Database schema

All tables live in Cloudflare D1 (SQLite), managed via Drizzle ORM.

### user (Better Auth)
| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `name` | text | |
| `email` | text unique | |
| `emailVerified` | boolean | |
| `image` | text | |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | auto on update |

### session (Better Auth)
| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `expiresAt` | timestamp | |
| `token` | text unique | |
| `userId` | text FK → user | cascade delete |
| `ipAddress` | text | |
| `userAgent` | text | |

### account (Better Auth — Google OAuth tokens)
| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `accountId` | text | Google account ID |
| `providerId` | text | `"google"` |
| `userId` | text FK → user | cascade delete |
| `accessToken` | text | Google access token |
| `refreshToken` | text | Google refresh token (offline access) |
| `idToken` | text | |
| `accessTokenExpiresAt` | timestamp | |
| `refreshTokenExpiresAt` | timestamp | |
| `scope` | text | OAuth scopes granted |
| `password` | text | Better Auth field, unused |

### meeting
| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | random UUID |
| `userId` | text FK → user | |
| `googleEventId` | text | Calendar event ID |
| `title` | text | Event summary |
| `meetLink` | text | `meet.google.com/xxx` |
| `startsAt` | timestamp | |
| `endsAt` | timestamp | |
| `status` | text | `scheduled` / `cancelled` / `completed` |
| `htmlLink` | text | Google Calendar event link |
| `workflowInstanceId` | text | Cloudflare Workflow instance ID |

Unique index on `(userId, googleEventId)` — one row per user per calendar event.

### participant
| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `meetingId` | text FK → meeting | cascade delete |
| `email` | text | |
| `displayName` | text | |
| `responseStatus` | text | `needsAction` / `declined` / `tentative` / `accepted` |

Unique index on `(meetingId, email)`. These are calendar invitees (RSVP), NOT actual joiners.

### bot_run
| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `meetingId` | text FK → meeting | cascade delete |
| `joinedAt` | timestamp | set when status → `joined` |
| `leftAt` | timestamp | set when recording uploaded |
| `status` | text | `pending` → `joining` → `waiting_admission` → `joined` → `left` / `failed` |
| `recordingKey` | text | path in Nextcloud, e.g. `recordings/{meetingId}/{botRunId}.webm` |
| `errorMessage` | text | failure reason |
| `workflowInstanceId` | text | |

---

## Authentication flow

1. User visits `/` → `beforeLoad` calls `getSession()` server fn. No session → redirect to `/login`.
2. On `/login`, user clicks "Sign in with Google".
3. `authClient.signIn.social({ provider: 'google', callbackURL: '/' })` redirects to Google.
4. User consents to OAuth scopes (`openid`, `email`, `profile`, `calendar.readonly`).
5. Google redirects to `/api/auth/callback/google`. Better Auth:
   - Creates/updates the `user` row
   - Stores OAuth tokens (`access_token`, `refresh_token`) in `account`
   - Creates a session in `session`
   - Sets a cookie via `tanstackStartCookies` plugin
6. Browser redirects to `/`. The loader calls `syncMeetingsFromCalendar()` which uses the fresh Google token.

**Google OAuth config** (`apps/web/src/lib/auth.ts:23-37`):
- `accessType: 'offline'` — Requests a `refresh_token` so calendar sync works without re-auth
- `prompt: 'select_account consent'` — Always shows account picker and re-consents
- `skipStateCookieCheck: true` — Google's consent screen can exceed the default 5-minute signed cookie TTL

---

## Meeting recording lifecycle

This is the full end-to-end flow from calendar sync to recording stored.

### 1. Calendar sync

When a user loads the dashboard, `syncMeetingsFromCalendar` is called:

1. Gets Google access token from Better Auth (auto-refreshes if expired)
2. Fetches `GET https://www.googleapis.com/calendar/v3/calendars/primary/events` (next 2 weeks, up to 50 events)
3. Filters events with Meet links (`conferenceData.entryPoints` or `hangoutLink`)
4. Upserts into D1 (`meeting` + `participant` tables)
5. Calls `scheduleMeetingBot()` for each event with status `scheduled`

### 2. Workflow scheduling

`scheduleMeetingBot()` in `apps/web/src/lib/schedule-bot.ts`:

- If the meeting is cancelled/completed or has no meet link → terminate any existing workflow, return `null`
- If schedule changed (different start time or meet link) → terminate old instance, create new
- If no existing workflow → create one: `env.MEETING_BOT_WORKFLOW.create({ id: meetingId, params })`

The workflow instance ID is the meeting ID (stable/consistent, one per meeting).

### 3. Workflow execution

`MeetingBotWorkflow` in `apps/web/src/workflows/meeting-bot.ts`:

**Step 1 — `prepare`**:
- Validates the meet link (`meet.google.com`)
- Creates a `bot_run` row with status `pending`
- Updates `meeting.workflowInstanceId`

**Step 2 — `sleepUntil('wake-t-minus-5')`**:
- Sleeps until `meeting.startsAt - 5 minutes` (or `now` if that's in the past)

**Step 3 — `launch`**:
- Updates `bot_run` status to `joining`
- Gets the `MeetBotContainer` Durable Object (`getContainer(env.MEET_BOT_CONTAINER, meetingId)`)
- Calls `container.startAndWaitForPorts()` — starts the Docker container, waits for `/health` to return 200
- Sends `POST /join` to the container with the full `JoinPayload` (meeting details + callback URL + secret)
- If launch fails → marks `bot_run` as `failed`, throws

**Step 4 — `waitForEvent('recording-done')`**:
- Blocks until the bot sends a `recording-done` event via `instance.sendEvent()`
- Timeout: `max(endsAt - now + 15 min, 15 min)`
- If timed out → marks `bot_run` as `failed` with timeout error

**Step 5 — `finalize`**:
- Updates `bot_run` with final status, `recordingKey`
- If successful (`status = 'left'`) → marks meeting as `completed`
- Sends `POST /stop` to the container for cleanup

### 4. Bot execution (inside Docker container)

`apps/meet-bot/index.ts` — `runBot()`:

1. Creates `MeetGuestSession` and `AudioRecorder`
2. Launches Chromium via Puppeteer (headed on macOS, headless in Docker)
3. Navigates to the Meet link
4. Dismisses dialogs ("Got it", "Dismiss", "Accept all", "Continue as guest", etc.)
5. Fills guest name input with `"DAC Notetaker"`
6. Turns off microphone and camera (click + Ctrl+D, Ctrl+E shortcuts)
7. Clicks "Ask to join" / "Join now"
8. Reports status `waiting_admission` → `POST /api/bot/status`
9. Polls every 2 seconds for admission (checks for "Leave call" button + no lobby text)
10. Reports status `joined`
11. Starts ffmpeg recording from PulseAudio null sink (`meet_sink.monitor`)
12. Polls every 5 seconds until meeting ends (text: "you left the meeting", "rejoin", "you've been removed") or `endsAt + 1min`
13. Clicks "Leave call"
14. Stops ffmpeg
15. Uploads `.webm` to `POST /api/bot/complete` (multipart form, `x-bot-secret` header)
16. Closes browser

On failure:
- Reports `failed` status to `/api/bot/status`
- Attempts to upload partial recording
- Falls back to an empty completion callback if upload fails

### 5. Recording upload

`POST /api/bot/complete` (`apps/web/src/routes/api/bot/complete.ts`):

1. Verifies `x-bot-secret` against `BOT_INTERNAL_SECRET`
2. If recording file present → uploads to Nextcloud via `getStorage().put('recordings/{meetingId}/{botRunId}.webm', file)`
3. Updates `bot_run` row: `status`, `recordingKey`, `leftAt`, `errorMessage`
4. Sends `recording-done` event to the workflow instance: `env.MEETING_BOT_WORKFLOW.get(workflowInstanceId).sendEvent(...)`

### 6. Storage

Nextcloud WebDAV path structure:
```
dac-googlemeet/
  recordings/
    {meetingId}/
      {botRunId}.webm
```

The `@repo/storage` package handles intermediate directory creation via sequential `MKCOL` calls before each `PUT`. All operations use fetch + HTTP Basic auth, compatible with Cloudflare Workers.

---

## Security model

### Bot-web auth
All bot → web API calls (`/api/bot/status`, `/api/bot/complete`) require an `x-bot-secret` header. This header is compared against `BOT_INTERNAL_SECRET`, a Wrangler secret shared between the web app and the bot container (injected into `JoinPayload.callbackSecret`).

### Google OAuth
- Tokens stored in D1 (`account` table). No tokens in cookies, localStorage, or client-side state.
- `access_type: offline` ensures a `refresh_token` is obtained at first consent.
- Better Auth's `getAccessToken()` auto-refreshes expired tokens using the refresh token.

### Secrets
All secrets are Wrangler secrets — never in `.env` files, never in git. Set via `wrangler secret put`.

| Secret | Used by | Purpose |
|--------|---------|---------|
| `BETTER_AUTH_SECRET` | web | Better Auth signing key |
| `GOOGLE_CLIENT_ID` | web | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | web | Google OAuth client secret |
| `BOT_INTERNAL_SECRET` | web + bot | Shared secret for bot <-> web auth |
| `NEXTCLOUD_URL` | web | Nextcloud base URL |
| `NEXTCLOUD_USER` | web | Nextcloud username |
| `NEXTCLOUD_PASSWORD` | web | Nextcloud password/app-password |

### Network
- The meet-bot container has `enableInternet: true` (required to reach Google Meet and the web app callback)
- Nextcloud should be reachable from the Cloudflare Worker (public internet or Cloudflare Tunnel)

---

## Deployment

### Cloudflare infrastructure

| Resource | Name |
|----------|------|
| Worker | `dac-google-meet` |
| D1 database | `dac-googlemeet` |
| Workflow | `meeting-bot-workflow` |
| Container | `MeetBotContainer` (Durable Object, image: `../meet-bot/Dockerfile`) |

### Production deploy

```bash
cd apps/web
bun run deploy              # Build + wrangler deploy (containers rollout: none)
bun run deploy:containers   # Build + wrangler deploy (containers enabled)
```

### Custom domain (planned)

The `wrangler.jsonc` has commented-out config for `meeting.darkalphacapital.com` — requires the domain zone to exist on the Cloudflare account first.
