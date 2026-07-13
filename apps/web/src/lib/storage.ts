import { createNextcloudStorage, type StorageAdapter } from '@repo/storage'
import { env } from 'cloudflare:workers'

let cached: StorageAdapter | null = null

/** Shared Nextcloud-backed object storage (recordings, future artifacts). */
export function getStorage(): StorageAdapter {
  if (cached) return cached

  const url = env.NEXTCLOUD_URL
  const user = env.NEXTCLOUD_USER
  const password = env.NEXTCLOUD_PASSWORD

  if (!url || !user || !password) {
    throw new Error(
      'Missing NEXTCLOUD_URL, NEXTCLOUD_USER, or NEXTCLOUD_PASSWORD',
    )
  }

  cached = createNextcloudStorage({
    url,
    user,
    password,
    rootPath: 'dac-googlemeet',
  })
  return cached
}
