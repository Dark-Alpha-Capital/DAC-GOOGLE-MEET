import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const enableContainers = process.env.ENABLE_CONTAINERS === '1'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    // Cloudflare owns the SSR env — do not also run nitro/vite (causes fetchViteEnv 404)
    cloudflare({
      viteEnvironment: { name: 'ssr' },
      // Default wrangler.jsonc has enable_containers: false; this file turns them on.
      ...(enableContainers
        ? { configPath: './wrangler.containers.jsonc' }
        : {}),
    }),
    tanstackStart(),
    viteReact(),
  ],
})

export default config
