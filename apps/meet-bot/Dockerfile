# syntax=docker/dockerfile:1

FROM oven/bun:1.2-debian

ENV DEBIAN_FRONTEND=noninteractive \
  PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
  PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  BOT_HEADED=1 \
  USE_CHROME_PROFILE=1 \
  BOT_USER_DATA_DIR=/data/chrome \
  BOT_PROFILE_DIRECTORY=Default \
  BOT_RECORD_MODE=ffmpeg \
  DISPLAY=:99 \
  HOME=/tmp \
  PORT=8080

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt,sharing=locked \
  apt-get update && apt-get install -y --no-install-recommends \
  chromium \
  fonts-liberation \
  ffmpeg \
  pulseaudio \
  pulseaudio-utils \
  xvfb \
  ca-certificates

WORKDIR /app
COPY package.json ./
RUN bun install --production
COPY index.ts ./
COPY src ./src
RUN bun run build
# Populated by: bun run bootstrap:linux-profile (gitignored; Linux sign-in only)
COPY chrome-user-data /data/chrome
RUN chmod -R a+rwX /data/chrome
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 8080
ENTRYPOINT ["/docker-entrypoint.sh"]
