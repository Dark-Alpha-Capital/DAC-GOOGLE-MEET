# dac-googlemeet

Automated Google Meet recording. The system signs into your Google Calendar, finds every event with a Meet link, and dispatches a headless Chromium bot that joins as a guest, records audio, and uploads the result to your own storage. No manual intervention — schedule a Meet, and the recording lands in your Nextcloud.

**Goal**: Replace manual meeting recording with a zero-touch pipeline. You schedule a Google Meet, and a bot joins at T-minus-5 minutes, records the audio, and uploads the `.webm` to Nextcloud via WebDAV.

---

## Architecture at a glance

```
User → Browser (TanStack Start SSR)
        │
        ├─ Google OAuth (Better Auth) → D1 (SQLite)
        ├─ Google Calendar API v3 → sync events with Meet links
        └─ Cloudflare Workflow per meeting:
             1. prepare     — create bot_run row (pending)
             2. sleepUntil  — wake at meeting.start - 5 min
             3. launch      — start Docker container (Chromium + ffmpeg)
             4. waitForEvent— wait for recording-done
             5. finalize    — mark complete, stop container

Container: Bun HTTP server on :8080
  └─ POST /join  → Puppeteer joins Meet as guest "DAC Notetaker"
       ├─ Dismisses dialogs, fills name, clicks "Ask to join"
       ├─ Monitors for admission, then captures audio via PulseAudio + ffmpeg
       └─ POST /api/bot/complete → uploads .webm to Nextcloud

Storage: Nextcloud WebDAV (fetch-based, Workers-compatible)
  recordings/{meetingId}/{botRunId}.webm
```

### Project structure

```
apps/
  web/          Dashboard (TanStack Start + Cloudflare Workers)
  meet-bot/     Bot container (Bun + Puppeteer + Chromium + ffmpeg)
  server/       Unused stub
packages/
  storage/      Nextcloud WebDAV client (@repo/storage, fetch-based)
  eslint-config/  Shared ESLint config
  typescript-config/  Shared tsconfig bases
  ui/           Stub component library
```

---

## Quick start

```bash
# Prerequisites: Bun >= 1.2.15, Google Cloud Console project with OAuth + Calendar API

# 1. Clone & install
git clone <repo-url> && cd dac-googlemeet
bun install

# 2. Set secrets (see docs/setup.md for details)
cd apps/web
bunx wrangler secret put BETTER_AUTH_SECRET
bunx wrangler secret put GOOGLE_CLIENT_ID
bunx wrangler secret put GOOGLE_CLIENT_SECRET
bunx wrangler secret put BOT_INTERNAL_SECRET
bunx wrangler secret put NEXTCLOUD_URL
bunx wrangler secret put NEXTCLOUD_USER
bunx wrangler secret put NEXTCLOUD_PASSWORD

# 3. Run DB migrations locally
bun run db:migrate:local

# 4. Start the dev server
bun run dev
# (with containers enabled for local testing)
ENABLE_CONTAINERS=1 bun run dev
```

---

## Key tech

| Layer | Technology |
|-------|-----------|
| Frontend | React 19 + TanStack Start v1 + Tailwind CSS v4 + shadcn/ui |
| Auth | Better Auth v1.5 (Google OAuth, D1 adapter) |
| Database | Cloudflare D1 (SQLite via Drizzle ORM) |
| Orchestration | Cloudflare Workflows + Containers (Durable Objects) |
| Bot | Puppeteer-core + Chromium + ffmpeg + PulseAudio |
| Storage | Nextcloud WebDAV (fetch-based, Workers-compatible) |
| Runtime | Bun (monorepo and bot), Cloudflare Workers (web) |
| Monorepo | Turborepo with Bun workspace |

---

## Documentation

- **[docs/architecture.md](docs/architecture.md)** — Full system architecture, data flow, and component deep-dive
- **[docs/setup.md](docs/setup.md)** — Local development setup, environment variables, and prerequisites
- **[docs/meet-bot.md](docs/meet-bot.md)** — How the bot joins, records, and handles edge cases
- **[docs/bot-google-account.md](docs/bot-google-account.md)** — Roadmap for a dedicated Google Workspace bot account

---

## Common commands

```bash
# Monorepo
bun run dev                     # Dev all apps
bun run build                   # Build all
bun run lint                    # Lint all
bun run check-types             # Type-check all
bun run format                  # Prettier

# Web app only
cd apps/web
bun run dev                     # Dev on :3000
bun run generate-routes         # Regen TanStack Router tree (required after route changes)
bun run test                    # Vitest
bun run db:generate             # Create Drizzle migration from schema changes
bun run db:migrate:local        # Apply migrations to local D1
bun run db:migrate:remote       # Apply migrations to remote D1
bun run deploy                  # Build + wrangler deploy

# Meet-bot only
cd apps/meet-bot
bun run dev                     # tsx src/server.ts
bun run build                   # tsc compile
bun run docker:build            # docker build
bun run docker:run              # docker run -p 8080:8080
```
