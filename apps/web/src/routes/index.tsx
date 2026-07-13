import { createFileRoute, redirect } from '@tanstack/react-router'

import { authClient } from '#/lib/auth-client'
import { getSession } from '#/lib/session'

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    const session = await getSession()
    if (!session) {
      throw redirect({ to: '/login' })
    }
    return { session }
  },
  component: HomePage,
})

function HomePage() {
  const { session } = Route.useRouteContext()

  return (
    <main className="page-wrap flex min-h-[70vh] flex-col items-center justify-center px-4 py-16">
      <h1 className="display-title text-center text-4xl font-bold tracking-tight text-[var(--sea-ink)] sm:text-5xl">
        dac-google meet
      </h1>
      <p className="mt-3 text-sm text-[var(--sea-ink-soft)]">
        Signed in as {session.user.email}
      </p>
      <button
        type="button"
        onClick={() => {
          void authClient.signOut({
            fetchOptions: {
              onSuccess: () => {
                window.location.href = '/login'
              },
            },
          })
        }}
        className="mt-8 rounded-full border border-[rgba(23,58,64,0.2)] bg-white/50 px-5 py-2.5 text-sm font-semibold text-[var(--sea-ink)] transition hover:border-[rgba(23,58,64,0.35)]"
      >
        Sign out
      </button>
    </main>
  )
}
