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

# Give Xvfb a moment to come up
sleep 0.5

if [ ! -d "$BOT_USER_DATA_DIR/Default" ]; then
  echo "[entrypoint] WARNING: no Chrome profile at $BOT_USER_DATA_DIR/Default — Meet joins will be guest/blocked"
else
  echo "[entrypoint] using Chrome profile $BOT_USER_DATA_DIR ($BOT_PROFILE_DIRECTORY)"
fi

echo "[entrypoint] DISPLAY=$DISPLAY BOT_HEADED=$BOT_HEADED USE_CHROME_PROFILE=$USE_CHROME_PROFILE — starting meet-bot"
exec bun run dist/index.js
