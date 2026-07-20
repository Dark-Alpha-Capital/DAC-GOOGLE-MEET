import { createFileRoute, redirect } from '@tanstack/react-router'

import { Button } from '#/components/ui/button'
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
    <main className="flex min-h-svh flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-4 py-16">
        <div className="w-full max-w-lg space-y-10 text-center">
          <div className="space-y-3">
            <p className="text-xs tracking-[0.2em] text-muted-foreground uppercase">
              Dark Alpha Capital
            </p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Welcome to the Meeting Board
            </h1>
            <p className="text-sm text-muted-foreground">
              Sign in with Google to manage Meet bots, transcripts, and
              attendance.
            </p>
          </div>

          <div className="border border-border bg-card p-6 sm:p-8">
            <Button
              className="w-full"
              size="lg"
              onClick={() => {
                void authClient.signIn.social({
                  provider: 'google',
                  callbackURL: '/',
                })
              }}
            >
              Continue with Google
            </Button>
          </div>
        </div>
      </div>
    </main>
  )
}
