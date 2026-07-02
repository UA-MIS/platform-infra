import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Vite config for the static SPA. `@tailwindcss/vite` is the Tailwind v4 plugin
// (no tailwind.config.js / postcss.config.js needed — Tailwind scans your source
// and the single `@import "tailwindcss";` in src/index.css does the rest).
// `vite build` emits the static site to ./dist, which the Dockerfile copies into nginx.
export default defineConfig({
  plugins: [react(), tailwindcss()],
})
