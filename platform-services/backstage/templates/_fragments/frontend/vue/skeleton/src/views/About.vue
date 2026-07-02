<script setup lang="ts">
// A second routed view, to demonstrate client-side routing (vue-router). nginx falls back
// to index.html so /about resolves on a hard refresh too.
</script>

<template>
  <section class="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
    <h2 class="mb-3 text-lg font-semibold">About ${{ values.appName }}</h2>
    <p class="text-sm text-slate-600">${{ values.description }}</p>
    <ul class="mt-4 list-disc space-y-1 pl-5 text-sm text-slate-600">
      <li>Vue 3 single-page app, built with Vite and TypeScript.</li>
      <li>Styled with Tailwind CSS v4.</li>
      <li>Calls the backend over a relative <code>/api</code> URL (same origin).</li>
      <li>Served in production by hardened nginx (non-root, read-only rootfs).</li>
    </ul>
  </section>
</template>
