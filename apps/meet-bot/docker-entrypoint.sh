#!/bin/sh
set -eu

# Virtual PulseAudio sink so Chromium Meet audio can be captured by ffmpeg.
pulseaudio --start --exit-idle-time=-1 2>/dev/null || true
pactl load-module module-null-sink sink_name=meet_sink sink_properties=device.description=MeetSink 2>/dev/null || true
pactl set-default-sink meet_sink 2>/dev/null || true

exec node dist/server.js
