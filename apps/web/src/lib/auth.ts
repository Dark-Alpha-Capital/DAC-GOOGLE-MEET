import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { env } from 'cloudflare:workers'

import { getDb } from '#/db'
import * as schema from '#/db/schema'

export function getAuth() {
  return betterAuth({
    database: drizzleAdapter(getDb(), {
      provider: 'sqlite',
      schema,
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: [env.BETTER_AUTH_URL],
    // OAuth state is stored in D1; skip the short-lived signed cookie check.
    // Google consent (esp. unverified + Calendar scopes) often exceeds the 5m cookie TTL.
    account: {
      skipStateCookieCheck: true,
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // openid/email/profile are included by default; add Calendar for offline sync
        scope: [
          'openid',
          'email',
          'profile',
          'https://www.googleapis.com/auth/calendar.readonly',
        ],
        // Required so Google returns a refresh_token (stored on account.refreshToken)
        accessType: 'offline',
        prompt: 'select_account consent',
      },
    },
    plugins: [tanstackStartCookies()],
  })
}

export type Auth = ReturnType<typeof getAuth>
export type Session = Auth['$Infer']['Session']
