import { createFileRoute, redirect } from '@tanstack/react-router'

import { authClient } from '#/lib/auth-client'
import { getSession } from '#/lib/session'

export const Route = createFileRoute('/login')({
  beforeLoad: async () => {
    const session = await getSession()
    if (session) {
      throw redirect({ to: '/' })
    }
  },
  component: LoginPage,
})

function LoginPage() {
  return (
    <main className="page-wrap flex min-h-[70vh] flex-col items-center justify-center px-4 py-16">
      <section className="island-shell w-full max-w-md rounded-2xl px-6 py-10 text-center">
        <h1 className="display-title text-3xl font-bold tracking-tight text-[var(--sea-ink)]">
          dac-google meet
        </h1>
        <p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
          Sign in to continue
        </p>
        <button
          type="button"
          onClick={() => {
            void authClient.signIn.social({
              provider: 'google',
              callbackURL: '/',
            })
          }}
          className="mt-8 w-full rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-3 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:bg-[rgba(79,184,178,0.24)]"
        >
          Sign in with Google
        </button>
      </section>
    </main>
  )
}
