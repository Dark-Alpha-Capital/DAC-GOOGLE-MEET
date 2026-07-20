import { createFileRoute, Outlet, redirect } from '@tanstack/react-router'

import Header from '#/components/Header'
import { getSession } from '#/lib/session'

export const Route = createFileRoute('/_app')({
  beforeLoad: async () => {
    const session = await getSession()
    if (!session) {
      throw redirect({ to: '/login' })
    }
    return { session }
  },
  component: AppLayout,
})

function AppLayout() {
  const { session } = Route.useRouteContext()

  return (
    <>
      <Header
        user={{
          email: session.user.email,
          name: session.user.name,
          image: session.user.image,
        }}
      />
      <Outlet />
    </>
  )
}
