# Bot Chrome profile for Cloudflare Containers

## Security model (read this)

Baking a signed-in Chromium profile into the container image is the **practical MVP** on Cloudflare Containers (no durable disk per instance). It is **not** zero-risk:

- The image contains Google session cookies for the bot Gmail.
- Anyone who can pull the image (account members, CI) can extract that session.
- Prefer a **dedicated** bot mailbox (`roghankundra@…`), not a personal inbox.
- Never commit `chrome-user-data/` or `bot-chrome-profile/` (already gitignored).
- Cloudflare’s container registry is account-private — do not push this image to a public registry.
- If the account is compromised, change the Google password and rebuild with a fresh profile.

Safer long-term options (not required for MVP): restore an encrypted profile from R2 at container start; or run the browser on a private VM and only keep the Worker on Cloudflare.

## Why not copy macOS Chrome?

Mac→Linux profile copies often lose login (Keychain / cookie encryption). Prefer logging in **once inside Linux Chromium**, then bake that directory.

`bun run sync:chrome-profile` (Mac Profile 5 → `chrome-user-data`) is for **local experiments only**. Do **not** treat it as production-ready for Cloudflare Containers.

## Bootstrap (one-time, required before `deploy:containers`)

```bash
cd apps/meet-bot
bun run docker:build

# Persist Linux profile on the host
mkdir -p chrome-user-data
docker run --rm -it \
  -v "$(pwd)/chrome-user-data:/data/chrome" \
  -e USE_CHROME_PROFILE=1 \
  -e BOT_USER_DATA_DIR=/data/chrome \
  --entrypoint bash meet-bot

# Inside the container:
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99
chromium --user-data-dir=/data/chrome --no-sandbox --disable-dev-shm-usage \
  https://accounts.google.com/
# Sign in as the bot Gmail, open meet.google.com once, quit Chromium, exit.
```

Confirm cookies exist:

```bash
ls chrome-user-data/Default/Cookies chrome-user-data/Default/Network/Cookies 2>/dev/null
```

The container entrypoint **exits with an error** if `USE_CHROME_PROFILE=1` and cookies are missing.

Then deploy from `apps/web`:

```bash
cd apps/web
bun run deploy:containers
```

The Dockerfile `COPY chrome-user-data /data/chrome` bakes the session into the image.
