import { createFileRoute, redirect } from '@tanstack/react-router'

import { Button } from '#/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#/components/ui/card'
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
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl tracking-tight">
            dac-google meet
          </CardTitle>
          <CardDescription>Sign in to continue</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            className="w-full"
            onClick={() => {
              void authClient.signIn.social({
                provider: 'google',
                callbackURL: '/',
              })
            }}
          >
            Sign in with Google
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}
