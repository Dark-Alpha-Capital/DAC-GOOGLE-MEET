# Bot Chrome profile for Cloudflare Containers

## Critical rule

Sign in with the **meet-bot Dockerfile Chromium on `linux/amd64`** — the same binary Cloudflare runs.

Sessions from `linuxserver/chromium` or Mac Chrome **will not stay signed in** on Cloudflare (cookie encryption / Chromium mismatch).

Also required: `Local State` must contain `os_crypt.encrypted_key`. Cookies alone are not enough — without the key, CF Chromium cannot decrypt SID and looks signed out.

# India: sign-in often stores SID on `.google.co.in` only. Meet needs a **real**
# `.google.com` session. Always bootstrap via **https://www.google.com/ncr** and
# confirm myaccount shows your email. Cookie cloning cannot fix Google 401s.

## Bootstrap

```bash
cd apps/meet-bot
bun run bootstrap:linux-profile
```

1. Open **http://127.0.0.1:3000/vnc.html** (password `meetbot`)
2. Sign in as the bot Gmail → open Meet + myaccount.google.com
3. **Quit Chromium** (File → Quit) so cookies flush to disk
4. Press Enter — script checks SID/OSID cookies (not headless dump-dom)
5. Deploy:

```bash
cd ../web && bun run deploy:containers
```

`deploy:containers` stamps the profile so Docker does not reuse a stale `COPY chrome-user-data` layer.

## Verify in Cloudflare logs

After join, look for `roghankundra@…` (or your bot email) in the Google account preview — **not** a bare “Sign in” landing page.
