# Meet Bot (Chromium guest joiner)

Docker image run by Cloudflare Containers (`MeetBotContainer`).

## Endpoints

- `GET /health` — liveness
- `GET /status` — current bot state
- `POST /join` — start guest Ask-to-join + record (202)
- `POST /stop` — leave / tear down browser

## Local run

```bash
npm install
npm run build
# Requires Chromium + PulseAudio + ffmpeg on the host, or use Docker:
docker build -t meet-bot .
docker run --rm -p 8080:8080 meet-bot
```
