<script setup lang="ts">
import type { Item } from '~/server/database/schema'

// Server-rendered fetch of the sample API. When DATABASE_URL is unset/unreachable the API
// returns 503; we surface a friendly banner instead of an error page, so the app stays
// usable on a fresh repo.
const { data, error } = await useFetch<{ items: Item[] }>('/api/items')
</script>

<template>
  <main style="max-width: 42rem; margin: 0 auto; padding: 2rem; font-family: system-ui, sans-serif">
    <h1>Items</h1>
    <p>
      Read from MySQL through Drizzle ORM. Create one with
      <code>POST /api/items</code> (body: <code>{ "name": "..." }</code>).
    </p>

    <div
      v-if="error"
      style="margin-top: 1.5rem; padding: 1rem; border: 1px solid #fcd34d; background: #fffbeb; border-radius: 6px"
    >
      The database is not reachable yet. Set <code>DATABASE_URL</code> in the Secrets tab
      and run <code>npm run db:migrate</code>.
    </div>
    <p v-else-if="!data || data.items.length === 0" style="margin-top: 1.5rem">
      No items yet.
    </p>
    <ul v-else style="margin-top: 1.5rem">
      <li v-for="item in data.items" :key="item.id">{{ item.name }}</li>
    </ul>

    <p style="margin-top: 2rem"><NuxtLink to="/">&larr; Home</NuxtLink></p>
  </main>
</template>
