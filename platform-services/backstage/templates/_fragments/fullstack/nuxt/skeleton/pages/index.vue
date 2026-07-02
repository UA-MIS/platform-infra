<script setup lang="ts">
const appName = 'Nuxt fullstack starter'
</script>

<template>
  <main style="max-width: 42rem; margin: 0 auto; padding: 2rem; font-family: system-ui, sans-serif">
    <h1>{{ appName }}</h1>
    <p>
      A Nuxt 3 fullstack app: Vue pages plus a Nitro server API in one deployable. The data
      layer is Drizzle ORM over MySQL, read from the <code>DATABASE_URL</code> env.
    </p>
    <ul>
      <li><NuxtLink to="/items">Items</NuxtLink> — a DB-backed sample page</li>
      <li><code>GET /api/items</code> — the JSON API behind it</li>
      <li><code>GET /healthz</code> — DB-independent health probe</li>
    </ul>
  </main>
</template>
