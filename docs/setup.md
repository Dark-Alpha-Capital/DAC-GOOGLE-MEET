# Setup — local development

## Prerequisites

- **Bun** >= 1.2.15 — package manager and runtime (enforced by `package.json` `devEngines`)
- **Node.js** >= 18 (for tooling compatibility)
- **Google Cloud Console project** with:
  - OAuth 2.0 consent screen configured
  - OAuth client ID (Web application type)
  - Google Calendar API enabled
- **Nextcloud instance** — self-hosted or managed, with WebDAV access
- **Cloudflare account** — with Workers, D1, Workflows, and Containers enabled
- **Docker** (optional) — for building and running the meet-bot container locally

---

## 1. Clone and install

```bash
git clone <repo-url> dac-googlemeet
cd dac-googlemeet
bun install
```

This installs all workspace dependencies (root + `apps/web` + `apps/meet-bot` + `packages/storage`).

---

## 2. Google Cloud Console setup

### Create OAuth credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Create an **OAuth 2.0 Client ID** (Web application)
3. Add authorized redirect URIs:
   - Local dev: `http://localhost:3000/api/auth/callback/google`
   - Production: `https://dac-google-meet.rahulguptax14.workers.dev/api/auth/callback/google`
   - Custom domain (planned): `https://meeting.darkalphacapital.com/api/auth/callback/google`
4. Note the **Client ID** and **Client Secret**

### Enable Calendar API

1. APIs & Services → Library
2. Search for "Google Calendar API" → Enable

### OAuth consent screen

1. APIs & Services → OAuth consent screen
2. Add scopes:
   - `openid` (included by default)
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `.../auth/calendar.readonly` (sensitive scope — may require verification for production)
3. Add test users (your email) while in "Testing" mode

---

## 3. Nextcloud setup

1. Ensure your Nextcloud instance is reachable from the internet (or at least from the Cloudflare Worker).
2. Create an app password (recommended over your main password):
   - Nextcloud → Settings → Security → Devices & sessions → Create new app password
3. Note: `URL`, `username`, and `password` (or app password)

---

## 4. Wrangler login

```bash
cd apps/web
bunx wrangler login
```

---

## 5. Set secrets

All secrets are set via `wrangler secret put`. These are stored encrypted in Cloudflare and never written to `.env`.

```bash
cd apps/web

# Better Auth signing key (generate a random string)
bunx wrangler secret put BETTER_AUTH_SECRET
# Paste: openssl rand -base64 32

# Google OAuth
bunx wrangler secret put GOOGLE_CLIENT_ID
bunx wrangler secret put GOOGLE_CLIENT_SECRET

# Shared secret between web app and bot container
bunx wrangler secret put BOT_INTERNAL_SECRET
# Paste: openssl rand -base64 32

# Nextcloud
bunx wrangler secret put NEXTCLOUD_URL      # e.g. https://cloud.example.com
bunx wrangler secret put NEXTCLOUD_USER      # your username
bunx wrangler secret put NEXTCLOUD_PASSWORD  # your app password
```

---

## 6. Database setup

### Run local migrations

```bash
cd apps/web
bun run db:migrate:local
```

This applies all migrations in `apps/web/drizzle/` to a local D1 instance (backed by a SQLite file).

### Run remote migrations (production)

```bash
bun run db:migrate:remote
```

### Schema changes

If you modify `apps/web/src/db/schema.ts`:

```bash
bun run db:generate              # Generate migration SQL
bun run db:migrate:local          # Apply locally
```

---

## 7. Generate routes (required after route changes)

```bash
cd apps/web
bun run generate-routes
```

This rebuilds the TanStack Router route tree from `src/routes/`. Required after adding, renaming, or removing route files. Without this, the dev server will fail with route resolution errors.

---

## 8. Run the dev server

### Web app only (no containers)

```bash
cd apps/web
bun run dev
# → http://localhost:3000
```

This runs the Vite dev server with the Cloudflare Vite plugin. It simulates the Worker environment locally. Containers are disabled in this mode.

### Web app with containers enabled

```bash
cd apps/web
ENABLE_CONTAINERS=1 bun run dev
```

This loads `wrangler.containers.jsonc` (which sets `enable_containers: true`) instead of `wrangler.jsonc`. Use this when you want to test the full workflow locally (requiring Docker to be running).

---

## 9. Run the meet-bot locally (standalone)

The meet-bot can be run outside Docker for development and debugging:

```bash
cd apps/meet-bot
bun install

# Run in dev mode (with tsx, live reload)
bun run dev

# Or compile and run
bun run build
bun run start
```

**Prerequisites for local bot**:
- Chromium/Chrome installed (macOS: Google Chrome or Chromium.app)
- ffmpeg installed (`brew install ffmpeg`)
- PulseAudio installed (`brew install pulseaudio`)

On macOS, the bot runs **headed** by default (visible browser window) so you can see what it's doing. On Linux/Docker it runs headless.

**Environment variables for local bot**:

```bash
# Optional overrides
export BOT_HEADED=1           # Force headed mode
export BOT_HEADED=0           # Force headless mode
export PUPPETEER_EXECUTABLE_PATH=/path/to/chrome
export BOT_USER_DATA_DIR=/path/to/chrome/profile  # For signed-in bot account
export PORT=8080              # Default is 8080
```

**Testing the bot locally**:

```bash
# Check health
curl http://localhost:8080/health

# Trigger a join (replace with a real test Meet link)
curl -X POST http://localhost:8080/join \
  -H 'content-type: application/json' \
  -d '{
    "meetingId": "test-123",
    "meetLink": "https://meet.google.com/xxx-yyyy-zzz",
    "displayName": "DAC Notetaker",
    "botRunId": "botrun-456",
    "endsAtMs": 1750000000000,
    "workflowInstanceId": "wf-789",
    "callbackBaseUrl": "http://localhost:3000",
    "callbackSecret": "test-secret"
  }'
```

---

## 10. Build the Docker container

```bash
cd apps/meet-bot
bun run docker:build    # docker build -t meet-bot .
bun run docker:run      # docker run -p 8080:8080 meet-bot
```

The Docker image is used by Cloudflare Containers in production. It includes Chromium, ffmpeg, PulseAudio, and the Bun runtime.

---

## 11. Deploy to Cloudflare

### First-time deploy

```bash
cd apps/web

# Deploy without containers (web app only)
bun run deploy

# Or deploy with container support
bun run deploy:containers
```

### Subsequent deploys

```bash
cd apps/web
bun run deploy              # Standard deploy
bun run deploy:containers   # With container image push
```

---

## Environment variable reference

### wrangler.jsonc vars (non-secret, in config file)

| Variable | Value | Purpose |
|----------|-------|---------|
| `BETTER_AUTH_URL` | `https://dac-google-meet.rahulguptax14.workers.dev` | Base URL for auth callbacks |
| `BOT_DISPLAY_NAME` | `DAC Notetaker` | Guest name the bot uses |

### Wrangler secrets (set via `wrangler secret put`)

| Secret | Required | Purpose |
|--------|----------|---------|
| `BETTER_AUTH_SECRET` | Yes | Better Auth signing key |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth client secret |
| `BOT_INTERNAL_SECRET` | Yes | Shared secret for bot ↔ web auth |
| `NEXTCLOUD_URL` | Yes | Nextcloud base URL |
| `NEXTCLOUD_USER` | Yes | Nextcloud username |
| `NEXTCLOUD_PASSWORD` | Yes | Nextcloud password or app password |

---

## Troubleshooting

### "Not signed in" on dashboard load

- Ensure the OAuth redirect URI matches exactly (trailing slash sensitive)
- Check that your email is listed as a test user in Google Cloud Console → OAuth consent screen
- Verify `skipStateCookieCheck: true` is set in `apps/web/src/lib/auth.ts` (Google consent can exceed 5-min cookie TTL)

### Calendar API errors

- Verify the Calendar API is enabled in Google Cloud Console
- Confirm `access_type: 'offline'` is set (required for refresh tokens)
- The user must re-consent if new scopes are added (use `prompt: 'select_account consent'`)

### Bot fails to join

- Some orgs block anonymous guest joining — see `docs/bot-google-account.md` for the dedicated account upgrade path
- Google may detect automation — the anti-detection flags help but are not foolproof
- Check `/tmp/meet-bot-debug/` on the bot container for debug screenshots and page text

### Nextcloud upload fails

- Verify WebDAV is enabled on the Nextcloud instance
- Check that the user has write permissions to the `dac-googlemeet` folder
- Ensure the Nextcloud URL is reachable from Cloudflare Workers (public internet)
- Try with an app password instead of the main account password
