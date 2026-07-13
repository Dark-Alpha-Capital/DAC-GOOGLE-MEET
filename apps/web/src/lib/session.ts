import { createServerFn } from '@tanstack/react-start'
import { getRequestHeaders } from '@tanstack/react-start/server'

import { getAuth } from '#/lib/auth'

export const getSession = createServerFn({ method: 'GET' }).handler(async () => {
  return getAuth().api.getSession({ headers: getRequestHeaders() })
})
