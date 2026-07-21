#!/usr/bin/env bash
# Bust Docker COPY cache for chrome-user-data before container deploy.
# Without this, wrangler/Docker may reuse a stale profile layer after re-login.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${ROOT}/chrome-user-data"
COOKIES_A="${PROFILE}/Default/Cookies"
COOKIES_B="${PROFILE}/Default/Network/Cookies"

if [[ ! -f "$COOKIES_A" && ! -f "$COOKIES_B" ]]; then
  echo "ERROR: no Chrome cookies under ${PROFILE}/Default"
  echo "Run: cd apps/meet-bot && bun run bootstrap:linux-profile"
  exit 1
fi

rm -f \
  "${PROFILE}/SingletonLock" \
  "${PROFILE}/SingletonCookie" \
  "${PROFILE}/SingletonSocket" \
  "${PROFILE}/.org.chromium.Chromium.lockfile"

# Cookies are v10-encrypted; without encrypted_key CF Chromium mints a new key → "not signed in".
bash "${ROOT}/scripts/ensure-os-crypt.sh" "${PROFILE}"
# India logins often only set .google.co.in — Meet needs .google.com.
bash "${ROOT}/scripts/sync-google-tld-cookies.sh" "${PROFILE}"

# Unique per deploy so COPY chrome-user-data is never CACHED across re-logins.
date -u +%Y%m%d%H%M%S.%N > "${PROFILE}/.bake-stamp"
echo "Stamped chrome profile for bake: $(cat "${PROFILE}/.bake-stamp")"
