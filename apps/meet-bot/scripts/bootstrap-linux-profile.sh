#!/usr/bin/env bash
# Sign the bot into Google using the SAME Chromium as Cloudflare Containers
# (meet-bot Dockerfile, linux/amd64).
#
# Usage:
#   cd apps/meet-bot && bun run bootstrap:linux-profile
#   cd ../web && bun run deploy:containers
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE_HOST="${ROOT}/chrome-user-data"
IMAGE="${MEET_BOT_IMAGE:-meet-bot-bootstrap}"
HTTP_PORT="${HTTP_PORT:-3000}"
VNC_PORT="${VNC_PORT:-5900}"
NAME="meet-bot-chrome-bootstrap"
PLATFORM="linux/amd64"

cd "$ROOT"

echo "==> Using amd64 meet-bot Chromium (same as Cloudflare Containers)."
echo ""

if [[ -d "${PROFILE_HOST}/Default" ]]; then
  BAK="${ROOT}/chrome-user-data.bak.$(date +%Y%m%d%H%M%S)"
  echo "==> Moving previous profile aside → ${BAK}"
  mv "${PROFILE_HOST}" "${BAK}"
fi
mkdir -p "${PROFILE_HOST}"

docker rm -f "${NAME}" >/dev/null 2>&1 || true

echo "==> Building ${IMAGE} (${PLATFORM})"
docker build --platform="${PLATFORM}" -t "${IMAGE}" .

echo ""
echo "==> Starting VNC bootstrap"
echo "    noVNC:  http://127.0.0.1:${HTTP_PORT}/vnc.html   (password: meetbot)"
echo "    VNC:    vnc://127.0.0.1:${VNC_PORT}              (password: meetbot)"
echo ""
echo "In the desktop:"
echo "  1. If redirected to google.co.in, open https://www.google.com/ncr first"
echo "  2. Sign in as the bot Gmail on accounts.google.com"
echo "  3. Open https://myaccount.google.com (must show your email — not account/about)"
echo "  4. Open https://meet.google.com once"
echo "  5. Quit Chromium (File → Quit) so cookies flush"
echo "  6. Back here: press Enter"
echo ""

docker run -d \
  --name "${NAME}" \
  --platform="${PLATFORM}" \
  --shm-size=1gb \
  -p "${VNC_PORT}:5900" \
  -p "${HTTP_PORT}:6080" \
  -v "${PROFILE_HOST}:/data/chrome" \
  --entrypoint bash \
  "${IMAGE}" \
  -lc '
    set -e
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends x11vnc novnc websockify >/dev/null
    Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset &
    export DISPLAY=:99
    sleep 0.8
    x11vnc -display :99 -forever -shared -rfbport 5900 -passwd meetbot >/tmp/x11vnc.log 2>&1 &
    websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
    echo "[bootstrap] VNC ready — password meetbot"
    rm -f /data/chrome/SingletonLock /data/chrome/SingletonCookie /data/chrome/SingletonSocket
    chromium \
      --user-data-dir=/data/chrome \
      --profile-directory=Default \
      --no-sandbox \
      --disable-dev-shm-usage \
      --no-first-run \
      --no-default-browser-check \
      --disable-gpu \
      --password-store=basic \
      --lang=en-US \
      "https://www.google.com/ncr" || true
    echo "[bootstrap] Chromium exited — flushing…"
    sleep 2
    tail -f /dev/null
  ' >/dev/null

cleanup() {
  docker rm -f "${NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> Waiting for noVNC on :${HTTP_PORT} …"
for _ in $(seq 1 120); do
  if curl -sf -o /dev/null "http://127.0.0.1:${HTTP_PORT}/vnc.html"; then
    echo "    UI up → http://127.0.0.1:${HTTP_PORT}/vnc.html"
    break
  fi
  sleep 2
done

if command -v open >/dev/null 2>&1; then
  open "http://127.0.0.1:${HTTP_PORT}/vnc.html" >/dev/null 2>&1 || true
fi

echo ""
read -r -p "Press Enter after quitting Chromium and finishing sign-in… " _

# Ask Chromium to exit cleanly before killing the container (flush Cookies DB).
docker exec "${NAME}" bash -lc 'pkill -TERM chromium || true; sleep 3; pkill -KILL chromium || true' >/dev/null 2>&1 || true
sleep 1
cleanup
trap - EXIT

echo ""
echo "==> Verifying Google session cookies on disk"
COOKIES_DB=""
if [[ -f "${PROFILE_HOST}/Default/Cookies" ]]; then
  COOKIES_DB="${PROFILE_HOST}/Default/Cookies"
elif [[ -f "${PROFILE_HOST}/Default/Network/Cookies" ]]; then
  COOKIES_DB="${PROFILE_HOST}/Default/Network/Cookies"
else
  echo "ERROR: no Cookies file — sign-in did not persist."
  exit 1
fi

rm -f \
  "${PROFILE_HOST}/SingletonLock" \
  "${PROFILE_HOST}/SingletonCookie" \
  "${PROFILE_HOST}/SingletonSocket" \
  "${PROFILE_HOST}/.org.chromium.Chromium.lockfile"

# Auth cookies (same signals Chromium needs). Headless --dump-dom is a false negative on Google.
SID_COUNT="$(
  sqlite3 "${COOKIES_DB}" \
    "SELECT COUNT(*) FROM cookies WHERE name IN ('SID','__Secure-1PSID','__Secure-3PSID','OSID') AND host_key LIKE '%google%';" \
    2>/dev/null || echo 0
)"
echo "    Auth cookie count (SID/PSID/OSID): ${SID_COUNT}"

if [[ "${SID_COUNT}" -lt 1 ]]; then
  echo "ERROR: no Google auth cookies found. Sign in again and quit Chromium cleanly."
  exit 1
fi

bash "${ROOT}/scripts/ensure-os-crypt.sh" "${PROFILE_HOST}"
bash "${ROOT}/scripts/sync-google-tld-cookies.sh" "${PROFILE_HOST}"

if ! python3 -c "import json; d=json.load(open('${PROFILE_HOST}/Local State')); assert d.get('os_crypt',{}).get('encrypted_key')" 2>/dev/null; then
  echo "ERROR: Local State still missing os_crypt.encrypted_key — CF Chromium will not decrypt cookies."
  exit 1
fi

echo "OK: Google auth cookies + os_crypt key + .google.com SID present. Profile is ready to bake."
echo ""
echo "Next:"
echo "  cd ../web && bun run deploy:containers"
echo "CF success: logs show SID@…google.com — not account/about."
