// Nuxt config — https://nuxt.com/docs/api/configuration/nuxt-config
//
// `preset: 'node-server'` makes `nuxt build` emit a self-contained Nitro server at
// .output/server/index.mjs (its node_modules are traced/bundled in), which the Dockerfile
// copies into a minimal runtime image. That server listens on $NITRO_PORT || $PORT (and
// $HOST), so the platform chart's PORT env drives the listen port. Default 8080.
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  nitro: {
    preset: 'node-server',
  },
  devtools: { enabled: false },
})
