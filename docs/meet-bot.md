# Meet bot

The meet-bot (`apps/meet-bot`) is a standalone Bun HTTP server that runs inside a Docker container. It receives a meeting join request, launches Chromium via Puppeteer, joins a Google Meet as a guest, records the audio, and uploads the result.

---

## How it works

### Join flow

When the bot receives a `POST /join` with a `JoinPayload`, it:

1. **Launches Chromium** via `puppeteer.launch()` with anti-automation flags.
   - On macOS: headed (visible window) by default for debugging.
   - In Docker/Linux: headless.
   - Override with `BOT_HEADED=1` or `BOT_HEADED=0`.
2. **Navigates** to the Meet URL (`payload.meetLink`).
3. **Blocks entry page check** — detects `"You can't join this video call"` text. If found, dumps a debug screenshot and throws. This usually means the meeting org blocks anonymous guests.
4. **Dismisses dialogs** — clicks away consent popups, cookie banners, and guest prompts:
   - "Got it", "Dismiss", "Accept all", "I agree"
   - "Continue without an account", "Continue as guest"
   - "Don't sign in", "Use the browser", "Join from your browser"
5. **Fills guest name** — finds the name input field (multiple selectors tried) and types `payload.displayName` (default: `"DAC Notetaker"`).
6. **Turns off media** — clicks "Turn off microphone" and "Turn off camera" buttons, then sends keyboard shortcuts (`Ctrl+D`, `Ctrl+E` on non-macOS; `Cmd+D`, `Cmd+E` on macOS).
7. **Clicks join** — clicks "Ask to join" / "Join now" / "Join meeting" / "Join".
8. **Reports status** — sends `POST /api/bot/status` with `status: waiting_admission`.

### Admission polling

`MeetGuestSession.waitForAdmission(timeoutMs)` polls every 2 seconds:

- Looks for the "Leave call" button AND absence of lobby text (`"asking to join"`, `"waiting for the host"`, etc.) → `'joined'`
- If lobby text present → still waiting, continues polling
- Timeout → `'waiting'`, dumps debug screenshot

Timeout is calculated as `max(endsAtMs - now, 10 minutes)`, so long meetings get a generous admission window.

### Recording

`AudioRecorder` spawns ffmpeg:

```bash
ffmpeg -y \
  -f pulse \
  -i meet_sink.monitor \
  -c:a libopus \
  -b:a 64k \
  /tmp/recording-{botRunId}.webm
```

The `meet_sink` is a PulseAudio null sink created by `docker-entrypoint.sh` before the bot starts:
```bash
pactl load-module module-null-sink sink_name=meet_sink
pactl set-default-sink meet_sink
```

Chromium outputs audio to this sink, and ffmpeg captures from its monitor source.

### Meeting end detection

`MeetGuestSession.waitUntilMeetingEnds(endsAtMs)` polls every 5 seconds for end-of-meeting text:

- `"you left the meeting"` — normal end
- `"rejoin"` — user was removed or meeting ended
- `"you've been removed"` — host removed the bot

Also stops when `Date.now() > endsAtMs + 1 minute`.

### Leave & cleanup

1. Clicks "Leave call" / "Leave meeting" / "Leave"
2. Stops ffmpeg (SIGINT, wait 5s, SIGKILL if needed)
3. Uploads `.webm` to `POST /api/bot/complete` (multipart form with `x-bot-secret` header)
4. Deletes the temp file
5. Closes the browser

### Failure handling

If any step fails:
1. Reports `status: failed` + error message to `POST /api/bot/status`
2. Tries to stop ffmpeg and upload the partial recording
3. If upload fails, sends an empty completion callback (without file) so the workflow doesn't hang forever

---

## Anti-detection

Google Meet uses automated join detection. The bot counters this with:

| Technique | Implementation |
|-----------|---------------|
| Automation flag removal | `--disable-blink-features=AutomationControlled` |
| Webdriver override | `Object.defineProperty(navigator, 'webdriver', { get: () => undefined })` |
| Fake media devices | `--use-fake-ui-for-media-stream`, `--use-fake-device-for-media-stream` |
| Default args skip | `ignoreDefaultArgs: ['--enable-automation']` |
| Human-like typing | Guest name typed with `delay: 15` between keystrokes |
| Stealth plugin | Puppeteer-extra + `puppeteer-extra-plugin-stealth` (planned) |

If Google still blocks the bot, check `/tmp/meet-bot-debug/` for screenshots and page text dumps. Common failure message:

> "You can't join this video call"

This usually means the meeting org has disabled guest access. See `docs/bot-google-account.md` for the dedicated Workspace account upgrade path.

---

## Docker container

### Image contents

```dockerfile
FROM oven/bun:1.2-debian

# Runtime deps
RUN apt-get install -y chromium ffmpeg pulseaudio pulseaudio-utils

# App
COPY package.json ./ && bun install --production
COPY index.ts src/ ./
RUN bun run build

# Audio setup
COPY docker-entrypoint.sh /
ENTRYPOINT ["/docker-entrypoint.sh"]
EXPOSE 8080
```

### docker-entrypoint.sh

```bash
#!/bin/sh
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=meet_sink
pactl set-default-sink meet_sink
exec bun run dist/index.js
```

Creates a PulseAudio null sink so Chromium's audio has somewhere to go, and ffmpeg can capture it.

### Building and running

```bash
cd apps/meet-bot
bun run docker:build     # docker build -t meet-bot .
bun run docker:run       # docker run -p 8080:8080 meet-bot
```

### Cloudflare Container config

In `wrangler.jsonc`:
```jsonc
"containers": [{
  "class_name": "MeetBotContainer",
  "image": "../meet-bot/Dockerfile",
  "instance_type": "standard-2",
  "max_instances": 20
}]
```

- **instance_type**: `standard-2` (2 vCPU, enough for headless Chromium + ffmpeg)
- **max_instances**: 20 concurrent bot containers
- Container sleeps after 3h of inactivity, but `onActivityExpired()` renews the timeout instead of stopping (Meet sessions outlive HTTP gaps)

---

## API endpoints

| Method | Path | Request | Response | Notes |
|--------|------|---------|----------|-------|
| `GET` | `/health` | — | `{ ok: true, state: "idle" }` | Container health check |
| `GET` | `/status` | — | `BotStatus` JSON | Current bot state |
| `POST` | `/join` | `JoinPayload` JSON | `202 { accepted: true }` | Starts bot asynchronously |
| `POST` | `/stop` | — | `{ stopped: true }` | Requests bot to leave and close |

### JoinPayload

```typescript
type JoinPayload = {
  meetingId: string          // D1 meeting.id
  meetLink: string           // meet.google.com/xxx-yyyy-zzz
  displayName: string        // "DAC Notetaker"
  botRunId: string           // D1 bot_run.id
  endsAtMs: number           // Meeting end time (unix ms)
  workflowInstanceId: string // Cloudflare Workflow instance id
  callbackBaseUrl: string    // Web app base URL for status/complete callbacks
  callbackSecret: string     // BOT_INTERNAL_SECRET for auth
}
```

### BotStatus

```typescript
type BotStatus = {
  state: 'idle' | 'joining' | 'waiting_admission' | 'joined' | 'recording' | 'leaving' | 'done' | 'failed'
  meetingId: string | null
  botRunId: string | null
  errorMessage: string | null
  startedAt: number | null
}
```

---

## Debugging

The bot writes debug artifacts to `/tmp/meet-bot-debug/` on certain failures:

- `<label>-<timestamp>.png` — full-page screenshot
- `<label>-<timestamp>.txt` — page URL + full text content

These are triggered on:
- Blocked entry page detection
- Admission timeout
- Join failure

To inspect these in a running container:
```bash
docker exec <container-id> ls -la /tmp/meet-bot-debug/
docker cp <container-id>:/tmp/meet-bot-debug ./debug-output/
```
