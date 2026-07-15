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

# Give Xvfb a moment to come up
sleep 0.5

echo "[entrypoint] DISPLAY=$DISPLAY BOT_HEADED=$BOT_HEADED — starting meet-bot"
exec bun run dist/index.js
