/** Body types accepted by storage adapters (Workers + Node). */
export type StorageBody =
  | ArrayBuffer
  | Uint8Array
  | Blob
  | ReadableStream<Uint8Array>
  | string

export type PutObjectOptions = {
  contentType?: string
}

export type PutObjectResult = {
  /** Logical object key (relative path under the adapter root). */
  key: string
  /** Absolute WebDAV / HTTP URL when known. */
  url: string
}

export type StorageAdapter = {
  put(
    key: string,
    body: StorageBody,
    options?: PutObjectOptions,
  ): Promise<PutObjectResult>
  exists(key: string): Promise<boolean>
  delete(key: string): Promise<void>
}

export type NextcloudStorageConfig = {
  /** Instance origin, e.g. https://dataroom.example.com */
  url: string
  user: string
  password: string
  /**
   * Folder under the user's Nextcloud files root.
   * Default: `dac-googlemeet`
   */
  rootPath?: string
}
