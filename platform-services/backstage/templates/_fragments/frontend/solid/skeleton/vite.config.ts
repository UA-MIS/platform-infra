import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'

// Vite config. Tailwind v4 is wired via the first-party @tailwindcss/vite plugin (no
// PostCSS / tailwind.config.js needed; utilities come from `@import "tailwindcss"` in
// src/index.css). vite-plugin-solid compiles Solid's JSX to fine-grained DOM updates.
//
// https://vite.dev/config/
export default defineConfig({
  plugins: [solid(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // LOCAL DEV ONLY: forward /api to the backend running on the same machine, so the
      // browser can call a relative `/api/...` URL exactly like it does in prod. In
      // production there is NO proxy — the platform ingress routes /api -> the backend
      // Service and / -> this frontend, so app code always uses relative /api paths.
      '/api': {
        target: 'http://localhost:${{ values.port }}',
        changeOrigin: true,
      },
    },
  },
})
