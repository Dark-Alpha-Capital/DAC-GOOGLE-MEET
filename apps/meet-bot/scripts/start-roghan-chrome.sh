#!/usr/bin/env bash
# Start a normal Chrome (not Puppeteer-launched) with Roghan's bot profile + CDP.
# Leave this window open. Sign in once if needed. Then run: bun run dev:roghan
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE_DIR="${ROOT}/bot-chrome-profile"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT="${BOT_CDP_PORT:-9222}"

mkdir -p "$PROFILE_DIR"

if [[ ! -x "$CHROME" ]]; then
  echo "Google Chrome not found at: $CHROME"
  exit 1
fi

if curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "Chrome CDP already listening on :${PORT}"
  curl -s "http://127.0.0.1:${PORT}/json/version" | head -c 400
  echo
  exit 0
fi

echo "Starting Chrome for Roghan bot…"
echo "  profile: $PROFILE_DIR"
echo "  CDP:     http://127.0.0.1:${PORT}"
echo ""
echo "If not signed in: sign in as roghankundra@gmail.com, open Meet once, KEEP THIS WINDOW OPEN."
echo "Then in another terminal: bun run dev:roghan"
echo ""

exec "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-blink-features=AutomationControlled \
  "https://myaccount.google.com/"
