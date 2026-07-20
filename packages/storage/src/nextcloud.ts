import type {
  GetObjectResult,
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

  async function collectionExists(relativePath: string): Promise<boolean> {
    const response = await fetch(davUrl(relativePath), {
      method: 'PROPFIND',
      headers: {
        Authorization: auth,
        Depth: '0',
      },
    })
    return response.status === 207 || response.status === 200
  }

  async function mkcol(relativePath: string) {
    if (await collectionExists(relativePath)) return

    const response = await fetch(davUrl(relativePath), {
      method: 'MKCOL',
      headers: { Authorization: auth },
    })

    if (
      response.status === 201 ||
      response.status === 405 ||
      response.status === 301 ||
      response.status === 200
    ) {
      return
    }

    // Conflict / forbidden: another writer may have created it
    if (
      (response.status === 409 || response.status === 403) &&
      (await collectionExists(relativePath))
    ) {
      return
    }

    const text = await response.text()
    throw new Error(
      `Nextcloud MKCOL failed (${response.status}) for ${joinPath(rootPath, relativePath)}: ${text}`,
    )
  }

  /** Ensure root + each nested folder under it exists. */
  async function ensureParentPath(objectKey: string) {
    await mkcol('') // rootPath itself (dac-googlemeet)

    const parent = objectKey.includes('/')
      ? objectKey.slice(0, objectKey.lastIndexOf('/'))
      : ''
    if (!parent) return

    const segments = parent.split('/')
    let built = ''
    for (const segment of segments) {
      built = joinPath(built, segment)
      await mkcol(built)
    }
  }

  return {
    async put(
      key: string,
      body: StorageBody,
      options?: PutObjectOptions,
    ): Promise<PutObjectResult> {
      const objectKey = normalizeKey(key)
      await ensureParentPath(objectKey)

      const url = davUrl(objectKey)
      const headers: Record<string, string> = {
        Authorization: auth,
        Overwrite: 'T',
      }
      if (options?.contentType) {
        headers['Content-Type'] = options.contentType
      }

      let uploadBody: BodyInit = body as BodyInit
      if (typeof Blob !== 'undefined' && body instanceof Blob) {
        uploadBody = await body.arrayBuffer()
      }

      const response = await fetch(url, {
        method: 'PUT',
        headers,
        body: uploadBody,
      })

      if (!response.ok && response.status !== 201 && response.status !== 204) {
        const text = await response.text()
        throw new Error(
          `Nextcloud PUT failed (${response.status}) for ${objectKey}: ${text}`,
        )
      }

      return { key: objectKey, url }
    },

    async get(key: string): Promise<GetObjectResult | null> {
      const response = await fetch(davUrl(normalizeKey(key)), {
        method: 'GET',
        headers: { Authorization: auth },
      })

      if (response.status === 404) return null
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => '')
        throw new Error(
          `Nextcloud GET failed (${response.status}) for ${normalizeKey(key)}: ${text}`,
        )
      }

      const length = response.headers.get('content-length')
      return {
        body: response.body,
        contentType: response.headers.get('content-type'),
        contentLength: length ? Number(length) : null,
      }
    },

    async exists(key: string): Promise<boolean> {
      return collectionExists(normalizeKey(key))
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
