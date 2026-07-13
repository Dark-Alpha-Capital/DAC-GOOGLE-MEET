import type {
  NextcloudStorageConfig,
  PutObjectOptions,
  PutObjectResult,
  StorageAdapter,
  StorageBody,
} from './types.js'

function trimSlash(value: string) {
  return value.replace(/\/+$/, '')
}

function normalizeKey(key: string) {
  return key.replace(/^\/+/, '').replace(/\/+/g, '/')
}

function joinPath(...parts: string[]) {
  return parts
    .filter(Boolean)
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

function basicAuthHeader(user: string, password: string) {
  const token = btoa(`${user}:${password}`)
  return `Basic ${token}`
}

/**
 * Nextcloud WebDAV storage (fetch-based, works on Cloudflare Workers).
 *
 * Uploads to: `{url}/remote.php/dav/files/{user}/{rootPath}/{key}`
 */
export function createNextcloudStorage(
  config: NextcloudStorageConfig,
): StorageAdapter {
  const baseUrl = trimSlash(config.url)
  const rootPath = normalizeKey(config.rootPath ?? 'dac-googlemeet')
  const auth = basicAuthHeader(config.user, config.password)
  const userSegment = encodeURIComponent(config.user)

  function davUrl(relativePath: string) {
    const path = joinPath(rootPath, relativePath)
    const encodedPath = path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    return `${baseUrl}/remote.php/dav/files/${userSegment}/${encodedPath}`
  }

  async function ensureCollection(dirKey: string) {
    const normalized = normalizeKey(dirKey)
    if (!normalized) return

    const segments = normalized.split('/')
    let built = ''
    for (const segment of segments) {
      built = joinPath(built, segment)
      const response = await fetch(davUrl(built), {
        method: 'MKCOL',
        headers: { Authorization: auth },
      })
      // 201 created, 405 already exists (method not allowed on existing), 409 parent missing (shouldn't happen)
      if (
        response.status === 201 ||
        response.status === 405 ||
        response.status === 301 ||
        response.status === 200
      ) {
        continue
      }
      if (response.status === 409) {
        // Parent missing — continue building; rare with sequential MKCOL
        continue
      }
      // Some Nextcloud versions return 403/404 for existing folders depending on config
      if (response.status === 403 || response.status === 404) {
        continue
      }
      const text = await response.text()
      throw new Error(
        `Nextcloud MKCOL failed (${response.status}) for ${built}: ${text}`,
      )
    }
  }

  return {
    async put(
      key: string,
      body: StorageBody,
      options?: PutObjectOptions,
    ): Promise<PutObjectResult> {
      const objectKey = normalizeKey(key)
      const parent = objectKey.includes('/')
        ? objectKey.slice(0, objectKey.lastIndexOf('/'))
        : ''
      if (parent) {
        await ensureCollection(parent)
      }

      const url = davUrl(objectKey)
      const headers: Record<string, string> = {
        Authorization: auth,
        Overwrite: 'T',
      }
      if (options?.contentType) {
        headers['Content-Type'] = options.contentType
      }

      const response = await fetch(url, {
        method: 'PUT',
        headers,
        body: body as BodyInit,
      })

      if (!response.ok && response.status !== 201 && response.status !== 204) {
        const text = await response.text()
        throw new Error(
          `Nextcloud PUT failed (${response.status}) for ${objectKey}: ${text}`,
        )
      }

      return { key: objectKey, url }
    },

    async exists(key: string): Promise<boolean> {
      const response = await fetch(davUrl(normalizeKey(key)), {
        method: 'PROPFIND',
        headers: {
          Authorization: auth,
          Depth: '0',
        },
      })
      return response.status === 207 || response.status === 200
    },

    async delete(key: string): Promise<void> {
      const response = await fetch(davUrl(normalizeKey(key)), {
        method: 'DELETE',
        headers: { Authorization: auth },
      })
      if (
        !response.ok &&
        response.status !== 204 &&
        response.status !== 404
      ) {
        const text = await response.text()
        throw new Error(
          `Nextcloud DELETE failed (${response.status}): ${text}`,
        )
      }
    },
  }
}
