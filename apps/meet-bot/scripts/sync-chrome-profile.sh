#!/usr/bin/env bash
# Copy the Roghan Chrome profile into apps/meet-bot/chrome-user-data for the bot.
# Quit Google Chrome fully before running (profile is locked while Chrome is open).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC_BASE="${HOME}/Library/Application Support/Google/Chrome"
SRC_PROFILE="${SRC_BASE}/Profile 5"
DEST="${ROOT}/chrome-user-data"

if [[ ! -d "$SRC_PROFILE" ]]; then
  echo "Profile not found: $SRC_PROFILE"
  echo "Expected Roghan (roghankundra@gmail.com) as Profile 5."
  exit 1
fi

if pgrep -xq "Google Chrome"; then
  echo "Quit Google Chrome completely, then re-run this script."
  echo "(Chrome locks the profile while it is open.)"
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST/Default"

echo "Copying Profile 5 → chrome-user-data/Default …"
# Core identity / session files (skip Cache, Code Cache, GPU — large & useless)
rsync -a --delete \
  --exclude 'Cache' \
  --exclude 'Code Cache' \
  --exclude 'GPUCache' \
  --exclude 'Service Worker/CacheStorage' \
  --exclude 'ShaderCache' \
  --exclude 'GrShaderCache' \
  --exclude 'Crashpad' \
  --exclude 'SplashscreenCache' \
  "$SRC_PROFILE/" "$DEST/Default/"

# Minimal Local State so Chromium treats Default as the active profile
python3 - <<PY
import json
from pathlib import Path
dest = Path("${DEST}")
state = {
  "profile": {
    "info_cache": {
      "Default": {"name": "DAC Notetaker", "user_name": "roghankundra@gmail.com"}
    },
    "last_used": "Default",
  }
}
(dest / "Local State").write_text(json.dumps(state))
print("Wrote Local State")
PY

echo "Done: $DEST"
echo "Note: Mac→Linux Docker may still require a fresh Google login (Keychain encryption)."
echo "Rebuild containers: cd apps/web && bun run dev:containers"
