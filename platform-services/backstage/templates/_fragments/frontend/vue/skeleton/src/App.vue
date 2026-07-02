<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
</script>

<template>
  <div class="min-h-screen bg-slate-50 text-slate-900">
    <div class="mx-auto max-w-2xl px-4 py-10">
      <header class="mb-8">
        <h1 class="text-3xl font-bold tracking-tight">${{ values.appName }}</h1>
        <p class="mt-1 text-slate-600">${{ values.description }}</p>
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
