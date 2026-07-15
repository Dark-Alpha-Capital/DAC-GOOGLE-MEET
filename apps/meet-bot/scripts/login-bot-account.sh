#!/usr/bin/env bash
# One-time login for the meet-bot Google account (roghankundra@gmail.com).
# Opens a dedicated Chrome window. Sign in, then quit that Chrome completely.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE_DIR="${ROOT}/bot-chrome-profile"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

mkdir -p "$PROFILE_DIR"

if [[ ! -x "$CHROME" ]]; then
  echo "Google Chrome not found at: $CHROME"
  exit 1
fi

echo "Opening Chrome with bot profile:"
echo "  $PROFILE_DIR"
echo ""
echo "1) Sign in as roghankundra@gmail.com"
echo "2) Open https://meet.google.com once to accept any prompts"
echo "3) Quit Chrome completely (Cmd+Q) when done"
echo ""

exec "$CHROME" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  "https://accounts.google.com/AddSession?Email=roghankundra@gmail.com&continue=https://meet.google.com"
