# AGENTS.md — dac-googlemeet

## Package manager

Always use **Bun** (`bun run`, `bun add`). The root `package.json` enforces `bun@1.2.15`. Bun is also used to install and run things inside `apps/web` — do not use npm or pnpm.

## Monorepo structure (Turborepo)

```
apps/
  web/          # Main app — TanStack Start + Cloudflare Workers
  meet-bot/     # Standalone Node.js Docker app — Puppeteer bot
  server/       # Empty stub (unused)
packages/
  eslint-config/      # Shared ESLint presets (@repo/eslint-config)
  storage/            # Nextcloud WebDAV client (@repo/storage)
  typescript-config/  # Shared tsconfig bases (@repo/typescript-config)
  ui/                 # Stub React component library (@repo/ui, starter boilerplate)
```

**Important**: The README is stale — it still describes a Next.js starter. The main app is **TanStack Start v1** (Vite-based), not Next.js. Ignore README claims about `web` and `docs` apps.

## Root-level commands

```bash
bun run dev              # Start all apps in dev mode
bun run build            # Build all apps/packages
bun run lint             # Lint all via ESLint
bun run check-types      # Type-check all via tsc
bun run format           # Prettier across all TS/TSX/MD
```

Use `--filter=` to target one workspace:
```bash
bun run dev --filter=web
bun run build --filter=meet-bot
```

## apps/web — TanStack Start dashboard

### Dev server
```bash
cd apps/web && bun run dev                   # Standard dev (port 3000)
cd apps/web && ENABLE_CONTAINERS=1 bun run dev  # Dev with Cloudflare Containers enabled
```

### Codegen (required after route changes)
```bash
cd apps/web && bun run generate-routes   # tsr generate — rebuilds TanStack Router tree
```
If you add, rename, or remove a route file under `src/routes/`, run this before the app will work.

### Database (Cloudflare D1 + Drizzle)
```bash
cd apps/web && bun run db:generate          # drizzle-kit generate — create migrations from schema changes
cd apps/web && bun run db:migrate:local     # Apply migrations to local D1
cd apps/web && bun run db:migrate:remote    # Apply migrations to remote D1
cd apps/web && bun run db:studio            # Drizzle Studio (local DB browser)
```

### Testing
```bash
cd apps/web && bun run test            # vitest run
```

### Deployment
```bash
cd apps/web && bun run deploy                # Build + wrangler deploy (no containers)
cd apps/web && bun run deploy:containers     # Build + wrangler deploy (with containers)
cd apps/web && bun run cf-typegen            # wrangler types — regenerate Cloudflare type bindings
```

### Key architecture details

- **Framework**: TanStack Start v1 (Vite 8 + React 19 + SSR via Cloudflare Workers).
- **Routing**: TanStack Router, file-based under `src/routes/`. The route tree is codegen-ed; always run `generate-routes` after route file changes.
- **Auth**: Better Auth v1.5 with Google OAuth (D1 adapter). The auth endpoint is `src/routes/api/auth/$.ts`. Session helpers in `src/lib/session.ts`.
- **DB**: Drizzle ORM over D1. Schema in `src/db/schema.ts`. Tables: `user`, `session`, `account`, `verification`, `meeting`, `participant`, `bot_run`.
- **Dual wrangler configs**: `wrangler.jsonc` (production, containers disabled) and `wrangler.containers.jsonc` (local dev with containers). Vite picks based on `ENABLE_CONTAINERS` env var.
- **Bot-web auth**: All bot <-> web endpoints (`/api/bot/status`, `/api/bot/complete`) are secured by `x-bot-secret` header checked against `BOT_INTERNAL_SECRET` (Wrangler secret).
- **Cloudflare Workflows**: `src/workflows/meeting-bot.ts` — wakes 5min before meeting, launches the meet-bot container, waits for recording event, finalizes.
- **Cloudflare Containers**: `src/containers/meet-bot.ts` — Durable Object class that manages the meet-bot Docker container lifecycle.
- **Server functions**: TanStack Start `createServerFn` RPC pattern — `syncMeetingsFromCalendar`, `getStoredMeetings`, `getSession` are called from client but run server-side.
- **TypeScript**: web uses TS 6.0.2 (not the root 5.9.2). Path aliases `#/*` and `@/*` both map to `./src/*`.
- **Styling**: Tailwind CSS v4 (`@tailwindcss/vite` plugin), shadcn/ui (New York style). Install shadcn components with `pnpm dlx shadcn@latest add <component>` (from `apps/web/` dir).
- **Env files**: `.env` and `.env.*` are gitignored but are build inputs in `turbo.json` — changes to env invalidate turbo cache.

## apps/meet-bot — Google Meet bot (Docker container)

A standalone **Node.js HTTP server** that runs inside a Cloudflare Container. It receives `POST /join`, launches Chromium via Puppeteer, joins the Google Meet as a guest, records audio via ffmpeg/PulseAudio, and uploads to the web app's callback endpoint.

### Commands
```bash
cd apps/meet-bot && bun run dev       # tsx src/server.ts (local dev)
cd apps/meet-bot && bun run build     # tsc compile
cd apps/meet-bot && bun run start     # node dist/server.js (run compiled)
cd apps/meet-bot && bun run docker:build  # docker build
cd apps/meet-bot && bun run docker:run    # docker run -p 8080:8080
```

### Key quirks
- Uses **Puppeteer-extra** with the **stealth plugin** for anti-detection.
- Anti-automation flags: `--disable-blink-features=AutomationControlled`, overrides `navigator.webdriver`, uses fake media device IDs.
- Locally runs Chromium **headed**; in Docker runs **headless** with `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`.
- Audio recorded to `/tmp/recording-{botRunId}.webm`, uploaded via multipart POST to the web app's callback.
- The Dockerfile installs `chromium`, `ffmpeg`, `pulseaudio` as runtime deps.

## packages/storage (`@repo/storage`)

Pure-fetch Nextcloud WebDAV client. Compatible with Cloudflare Workers (no Node.js deps). Used by `apps/web/src/lib/storage.ts` for storing bot recordings.

## Shared config packages

- `@repo/eslint-config`: `base.js` converts all ESLint errors to warnings via `eslint-plugin-only-warn`.
- `@repo/typescript-config`: Provides `base.json`, `nextjs.json`, `react-library.json` tsconfig presets. Note that `apps/web` uses its own tsconfig (not these presets).

## General conventions

- Prettier for formatting. Run `bun run format` before committing.
- ESLint flat config (v9). Each app has its own `eslint.config.js`.
- `.env` files are gitignored but respected at build time (Turbo inputs). Secrets go into Wrangler secrets (`wrangler secret put`), not env files.
- The project installs Cloudflare and Better Auth skills (see `skills-lock.json`) — when generating Cloudflare Workers, Durable Objects, or Better Auth code, prefer loading the relevant skill for up-to-date guidance.
