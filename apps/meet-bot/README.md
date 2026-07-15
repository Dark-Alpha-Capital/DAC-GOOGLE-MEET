# Meet Bot (Chromium guest joiner)

Bun app run by Cloudflare Containers (`MeetBotContainer`).

## Endpoints

- `GET /health` — liveness
- `GET /status` — current bot state
- `POST /join` — start guest Ask-to-join + record (202)
- `POST /stop` — leave / tear down browser

## Local

```bash
bun install
bun run dev

# Or Docker:
bun run docker:build
bun run docker:run
```
