#!/usr/bin/env bash
# One-time: sign the bot into Google inside Linux Chromium, then bake that
# profile into the Cloudflare container image on deploy.
#
# Fast path: pulls a prebuilt Chromium desktop image (no apt / meet-bot build).
# Defaults to native arch (arm64 on Apple Silicon) so the ~1GB pull is much faster.
# Session cookies are portable into Cloudflare's amd64 meet-bot image.
# Override: BOOTSTRAP_PLATFORM=linux/amd64 bun run bootstrap:linux-profile
#
# Usage:
#   cd apps/meet-bot
#   bun run bootstrap:linux-profile
#   # open http://127.0.0.1:3000 → sign in → Enter when done
#   cd ../web && bun run deploy:containers
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE_HOST="${ROOT}/chrome-user-data"
BOOTSTRAP_IMAGE="${BOOTSTRAP_IMAGE:-lscr.io/linuxserver/chromium:latest}"
HTTP_PORT="${HTTP_PORT:-3000}"
HTTPS_PORT="${HTTPS_PORT:-3001}"
NAME="meet-bot-chrome-bootstrap"

ARCH="$(uname -m)"
case "${BOOTSTRAP_PLATFORM:-}" in
  linux/amd64|linux/arm64) PLATFORM="$BOOTSTRAP_PLATFORM" ;;
  *)
    if [[ "$ARCH" == "arm64" || "$ARCH" == "aarch64" ]]; then
      PLATFORM="linux/arm64"
    else
      PLATFORM="linux/amd64"
    fi
    ;;
esac

cd "$ROOT"

echo "==> Platform: ${PLATFORM} (set BOOTSTRAP_PLATFORM=linux/amd64 to force CF arch)"
echo ""

# Stale Mac-copied profiles look signed-in (Cookies exist) but fail on Linux.
if [[ -f "${PROFILE_HOST}/Default/Cookies" || -f "${PROFILE_HOST}/Default/Network/Cookies" ]]; then
  BAK="${ROOT}/chrome-user-data.mac-bak.$(date +%Y%m%d%H%M%S)"
  echo "==> Moving existing profile aside (likely Mac / invalid on Linux):"
  echo "    ${PROFILE_HOST} → ${BAK}"
  mv "${PROFILE_HOST}" "${BAK}"
fi
mkdir -p "${PROFILE_HOST}"

docker rm -f "${NAME}" >/dev/null 2>&1 || true

echo "==> Pulling prebuilt Chromium (${PLATFORM})"
echo "    ~1GB image — watch layer MB counters climb; finished layers stay cached."
echo "    Only Ctrl+C if there is zero progress for 10+ minutes."
docker pull --platform="${PLATFORM}" "${BOOTSTRAP_IMAGE}"

echo ""
echo "==> Starting bootstrap UI"
echo "    Browser:  http://127.0.0.1:${HTTP_PORT}  (or https://127.0.0.1:${HTTPS_PORT})"
echo "    Profile:  ${PROFILE_HOST}"
echo ""
echo "In the Chromium window:"
echo "  1. Sign in as the dedicated bot Gmail"
echo "  2. Open https://meet.google.com once (accept prompts)"
echo "  3. Confirm you see your account (not a Sign-in landing page)"
echo "  4. Back here: press Enter to stop and verify cookies"
echo ""

docker run -d \
  --name "${NAME}" \
  --platform="${PLATFORM}" \
  --shm-size=1gb \
  -e PUID="$(id -u)" \
  -e PGID="$(id -g)" \
  -e TZ=Etc/UTC \
  -e "CHROME_CLI=--user-data-dir=/config/chrome --profile-directory=Default --no-first-run --no-default-browser-check https://accounts.google.com/" \
  -p "${HTTP_PORT}:3000" \
  -p "${HTTPS_PORT}:3001" \
  -v "${PROFILE_HOST}:/config/chrome" \
  "${BOOTSTRAP_IMAGE}" >/dev/null

cleanup() {
  docker rm -f "${NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Waiting for UI on :${HTTP_PORT} …"
for _ in $(seq 1 90); do
  if curl -sf -o /dev/null "http://127.0.0.1:${HTTP_PORT}/"; then
    echo "    UI is up → open http://127.0.0.1:${HTTP_PORT}"
    break
  fi
  sleep 2
done

if command -v open >/dev/null 2>&1; then
  open "http://127.0.0.1:${HTTP_PORT}" >/dev/null 2>&1 || true
fi

echo ""
read -r -p "Press Enter after you have signed in and opened Meet once… " _

echo ""
echo "==> Verifying Linux profile cookies"
COOKIES_A="${PROFILE_HOST}/Default/Cookies"
COOKIES_B="${PROFILE_HOST}/Default/Network/Cookies"
if [[ -f "$COOKIES_A" || -f "$COOKIES_B" ]]; then
  echo "OK: cookies found under ${PROFILE_HOST}/Default"
else
  echo "ERROR: no Cookies file under ${PROFILE_HOST}/Default"
  echo "Sign-in did not persist — try again (stay signed in, then press Enter)."
  exit 1
fi

echo ""
echo "Next — bake profile into the Worker container image and deploy:"
echo "  cd ../web && bun run deploy:containers"
echo ""
echo "Success looks like: guest=false, and no 'not signed in to Google' error."
