# Bot Chrome profile for Cloudflare Containers

## Security model (read this)

Baking a signed-in Chromium profile into the container image is the **practical MVP** on Cloudflare Containers (no durable disk per instance). It is **not** zero-risk:

- The image contains Google session cookies for the bot Gmail.
- Anyone who can pull the image (account members, CI) can extract that session.
- Prefer a **dedicated** bot mailbox, not a personal inbox.
- Never commit `chrome-user-data/` (gitignored).
- Cloudflare’s container registry is account-private — do not push this image to a public registry.

## Why not copy macOS Chrome?

Mac→Linux profile copies lose login (Keychain / cookie encryption).  
`bun run sync:chrome-profile` is **local experiments only** — not for Cloudflare.

## Bootstrap (fast — no meet-bot Docker build)

```bash
cd apps/meet-bot
bun run bootstrap:linux-profile
```

This **pulls** `lscr.io/linuxserver/chromium` (`linux/amd64`) and opens a web UI — it does **not** apt-install Chromium into `meet-bot` (that 20+ min build is only needed on deploy).

1. Open **http://127.0.0.1:3000**
2. Sign in as the bot Gmail → open Meet once
3. Press Enter in the terminal when done
4. Deploy (Dockerfile `COPY chrome-user-data /data/chrome`):

```bash
cd ../web && bun run deploy:containers
```

First `deploy:containers` still installs Chromium in the meet-bot image (slow once; then Docker/Wrangler cache helps). Bootstrap itself should only take as long as the image pull + sign-in.

## Verify

Join logs should show `guest=false` / `userDataDir=/data/chrome` and must **not** say the profile is not signed in.
