# @repo/storage

Reusable object storage adapters.

## Nextcloud (WebDAV)

```ts
import { createNextcloudStorage } from '@repo/storage'

const storage = createNextcloudStorage({
  url: process.env.NEXTCLOUD_URL!,
  user: process.env.NEXTCLOUD_USER!,
  password: process.env.NEXTCLOUD_PASSWORD!,
  rootPath: 'dac-googlemeet', // optional
})

await storage.put('recordings/meeting-id/run.webm', file, {
  contentType: 'audio/webm',
})
```

Env:

- `NEXTCLOUD_URL` — e.g. `https://dataroom.example.com`
- `NEXTCLOUD_USER` — Nextcloud username
- `NEXTCLOUD_PASSWORD` — app password (preferred) or account password
