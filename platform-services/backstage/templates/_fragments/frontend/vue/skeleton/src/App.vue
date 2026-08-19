<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'

// Bound (task #11, D-112), not raw-templated: description is free text and Vue's own
// {{ }} interpolation always HTML-escapes a bound value and never re-parses it as
// template source, unlike substituting it directly into the template as scaffold-time
// text (which broke on '<'/'&' and, worse, would let a literal "{{ ... }}" in the
// description execute as a live Vue expression).
const appDescription = ${{ values.description | dump }}
</script>

<template>
  <div class="min-h-screen bg-slate-50 text-slate-900">
    <div class="mx-auto max-w-2xl px-4 py-10">
      <header class="mb-8">
        <h1 class="text-3xl font-bold tracking-tight">${{ values.appName }}</h1>
        <p class="mt-1 text-slate-600">{{ appDescription }}</p>
        <p class="mt-1 text-sm text-slate-500">
          Vue 3 (Vite) frontend &middot; calls the backend API at <code>/api</code>.
        </p>
        <nav class="mt-4 flex gap-4 text-sm">
          <RouterLink
            to="/"
            class="text-slate-700 hover:underline"
            active-class="font-semibold text-slate-900"
          >
            Home
          </RouterLink>
          <RouterLink
            to="/about"
            class="text-slate-700 hover:underline"
            active-class="font-semibold text-slate-900"
          >
            About
          </RouterLink>
        </nav>
      </header>

      <RouterView />
    </div>
  </div>
</template>
