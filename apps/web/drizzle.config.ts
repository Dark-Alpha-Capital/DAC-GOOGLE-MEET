import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'drizzle-kit'

function getLocalD1Url() {
  const dir = join(
    process.cwd(),
    '.wrangler/state/v3/d1/miniflare-D1DatabaseObject',
  )

  if (!existsSync(dir)) {
    throw new Error(
      'Local D1 not found. Run `bun run db:migrate:local` (and `bun run dev` once) first.',
    )
  }

  const dbFile = readdirSync(dir).find(
    (file) => file.endsWith('.sqlite') && file !== 'metadata.sqlite',
  )

  if (!dbFile) {
    throw new Error(
      'No local D1 sqlite file found. Run `bun run db:migrate:local` first.',
    )
  }

  return join(dir, dbFile)
}

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'sqlite',
  dbCredentials: {
    url: getLocalD1Url(),
  },
})
