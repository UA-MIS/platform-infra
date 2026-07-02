import adapter from '@sveltejs/adapter-node'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

// adapter-node builds a standalone Node server into ./build. Run it with `node build`;
// it listens on the PORT + HOST env vars (the platform chart sets PORT from this
// component's port; default 8080). See https://svelte.dev/docs/kit/adapter-node
/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
  },
}

export default config
