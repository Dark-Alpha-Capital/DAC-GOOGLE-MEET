# Dedicated bot Google account (future)

MVP joins Meet as a **guest** (“Ask to join”) with display name `DAC Notetaker`.
This document describes the upgrade path to a dedicated Workspace user.

## Why upgrade

- Some orgs **block anonymous guests**
- Named Workspace bots are easier for hosts to trust/admit
- Persistent identity across meetings (Otter/Fireflies style)

## Target setup

1. Create a Workspace user, e.g. `notetaker@yourdomain.com`
2. Display name: `DAC Notetaker`
3. Prefer **app passwords / SSO-managed session** over storing the account password long-term
4. Disable interactive 2FA prompts for this account where policy allows (or use a hardware/TOTP path you control in automation)

## Join mode flag

```bash
BOT_JOIN_MODE=guest|account   # default: guest
```

- `guest` — current MVP path (no Google login)
- `account` — Puppeteer loads a persisted Chromium profile, opens Meet already signed in

## Session persistence (recommended)

Do **not** re-login with email/password every meeting.

1. One-time interactive login (manual or assisted) to produce a Chromium user-data-dir
2. Persist profile tarball / cookies to **R2** (or Durable Object storage)
3. On each bot start: restore profile → launch Chrome with `--user-data-dir=...`
4. Refresh/re-auth only when session expires or Google challenges

Store secrets in Wrangler secrets (`BOT_GOOGLE_EMAIL`, encrypted profile key), never in git.

## Puppeteer sketch

```ts
// Pseudocode for account mode
const profileDir = await restoreProfileFromR2(meetingId)
const browser = await puppeteer.launch({
  userDataDir: profileDir,
  args: ['--no-sandbox', /* ... */],
})
const page = await browser.newPage()
await page.goto(meetLink)
// Already logged in → click Join now (often no Ask to join for same-org)
```

## Risks

- Google bot / automation detection and CAPTCHA
- Session expiry and Workspace admin policies (2SV, context-aware access)
- Account abuse if credentials leak — use least privilege and rotate
- Meet UI selectors remain brittle either way

## Migration steps

1. Keep `BOT_JOIN_MODE=guest` in production
2. Implement profile restore + account join behind the flag in `apps/meet-bot`
3. Pilot on internal meetings where guests are blocked
4. Switch default when stable
