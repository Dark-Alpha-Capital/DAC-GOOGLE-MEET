#!/bin/sh
set -eu

echo "[entrypoint] starting PulseAudio + Xvfb"

# Virtual PulseAudio sink so Chromium Meet audio can be captured by ffmpeg.
pulseaudio --start --exit-idle-time=-1 2>/dev/null || true
pactl load-module module-null-sink sink_name=meet_sink sink_properties=device.description=MeetSink 2>/dev/null || true
pactl set-default-sink meet_sink 2>/dev/null || true

# Virtual display — Meet often blocks true headless Chromium.
Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset &
export DISPLAY=:99
export BOT_HEADED=1
export USE_CHROME_PROFILE="${USE_CHROME_PROFILE:-1}"
export BOT_USER_DATA_DIR="${BOT_USER_DATA_DIR:-/data/chrome}"
export BOT_PROFILE_DIRECTORY="${BOT_PROFILE_DIRECTORY:-Default}"
export BOT_RECORD_MODE="${BOT_RECORD_MODE:-ffmpeg}"
export PULSE_SINK="${PULSE_SINK:-meet_sink}"
export PULSE_SOURCE="${PULSE_SOURCE:-meet_sink.monitor}"

# Give Xvfb a moment to come up
sleep 0.5

PROFILE_DIR="$BOT_USER_DATA_DIR/$BOT_PROFILE_DIRECTORY"
COOKIES="$PROFILE_DIR/Cookies"
COOKIES_DB="$PROFILE_DIR/Network/Cookies"

# Singleton* from bootstrap (or a crash) → "profile in use by another Chromium process".
clear_chrome_locks() {
  dir="$1"
  [ -d "$dir" ] || return 0
  # -f: Singleton* are often symlinks; ignore missing.
  find "$dir" -maxdepth 1 \( -name 'Singleton*' -o -name '.org.chromium.Chromium.lockfile' \) -exec rm -f {} + 2>/dev/null || true
  echo "[entrypoint] cleared Chromium profile locks under $dir"
}

if [ "$USE_CHROME_PROFILE" = "1" ]; then
  if [ ! -d "$PROFILE_DIR" ]; then
    echo "[entrypoint] ERROR: USE_CHROME_PROFILE=1 but missing $PROFILE_DIR"
    echo "[entrypoint] Bootstrap a Linux Chromium login — see scripts/bootstrap-linux-profile.md"
    exit 1
  fi
  if [ ! -f "$COOKIES" ] && [ ! -f "$COOKIES_DB" ]; then
    echo "[entrypoint] ERROR: no Cookies file under $PROFILE_DIR — Google session missing"
    echo "[entrypoint] Sign in inside Linux Chromium, then rebuild the image."
    exit 1
  fi
  clear_chrome_locks "$BOT_USER_DATA_DIR"
  echo "[entrypoint] using Chrome profile $BOT_USER_DATA_DIR ($BOT_PROFILE_DIRECTORY)"
else
  echo "[entrypoint] WARNING: USE_CHROME_PROFILE off — guest joins will likely be blocked by Meet"
fi

echo "[entrypoint] DISPLAY=$DISPLAY BOT_HEADED=$BOT_HEADED PULSE_SINK=$PULSE_SINK — starting meet-bot"
exec bun run dist/index.js
