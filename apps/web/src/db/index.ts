import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/d1'

import * as schema from './schema.ts'

export function getDb() {
  return drizzle(env.DB, { schema })
}

export type Db = ReturnType<typeof getDb>
