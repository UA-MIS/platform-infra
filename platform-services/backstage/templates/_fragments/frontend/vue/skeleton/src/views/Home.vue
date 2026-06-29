<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

// The frontend talks to the backend over the SAME origin under /api. In production the
// platform ingress routes /api -> the backend and / -> this SPA; in local dev the Vite
// proxy (vite.config.ts) forwards /api to the backend. So ALWAYS use a relative
// `/api/...` URL — never a hardcoded host.

interface Health {
  status: string
  db: string
  time: string
}

interface Item {
  id: number
  name: string
}

const health = ref<Health | null>(null)
const items = ref<Item[]>([])
const name = ref('')
const error = ref<string | null>(null)

async function loadHealth() {
  try {
    const res = await fetch('/api/health')
    if (!res.ok) throw new Error('GET /api/health -> HTTP ' + res.status)
    health.value = (await res.json()) as Health
  } catch (e) {
    error.value = String(e)
  }
}

async function loadItems() {
  try {
    const res = await fetch('/api/items')
    if (res.status === 503) {
      // DATABASE_URL not set yet — expected on a fresh repo. Show health, skip the list.
      items.value = []
      return
    }
    if (!res.ok) throw new Error('GET /api/items -> HTTP ' + res.status)
    const data = await res.json()
    items.value = data.items ?? []
  } catch (e) {
    error.value = String(e)
  }
}

async function addItem() {
  const value = name.value.trim()
  if (!value) return
  try {
    const res = await fetch('/api/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: value }),
    })
    if (!res.ok) throw new Error('POST /api/items -> HTTP ' + res.status)
    name.value = ''
    await loadItems()
  } catch (e) {
    error.value = String(e)
  }
}

async function removeItem(id: number) {
  try {
    const res = await fetch('/api/items/' + id, { method: 'DELETE' })
    if (!res.ok && res.status !== 204) throw new Error('DELETE /api/items -> HTTP ' + res.status)
    await loadItems()
  } catch (e) {
    error.value = String(e)
  }
}

const dbBadge = computed(() =>
  health.value?.db === 'up'
    ? 'bg-green-100 text-green-800'
    : health.value?.db === 'down'
      ? 'bg-red-100 text-red-800'
      : 'bg-amber-100 text-amber-800',
)

onMounted(() => {
  error.value = null
  loadHealth()
  loadItems()
})
</script>

<template>
  <section class="mb-8 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
    <h2 class="mb-3 text-lg font-semibold">Backend health</h2>
    <div v-if="health" class="flex items-center gap-3 text-sm">
      <span class="rounded bg-slate-100 px-2 py-1 font-mono">status: {{ health.status }}</span>
      <span :class="'rounded px-2 py-1 font-mono ' + dbBadge">db: {{ health.db }}</span>
      <span class="text-slate-500">{{ health.time }}</span>
    </div>
    <p v-else class="text-sm text-slate-500">Contacting the backend…</p>
    <p v-if="health?.db === 'unconfigured'" class="mt-3 text-sm text-amber-700">
      No database configured. Add a <code>DATABASE_URL</code> secret via the Secrets tab in
      The Process to enable the items list below.
    </p>
  </section>

  <section class="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
    <h2 class="mb-3 text-lg font-semibold">Items (sample CRUD)</h2>
    <form class="mb-4 flex gap-2" @submit.prevent="addItem">
      <input
        v-model="name"
        class="flex-1 rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
        placeholder="New item name"
      />
      <button
        type="submit"
        class="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
      >
        Add
      </button>
    </form>

    <p v-if="items.length === 0" class="text-sm text-slate-500">No items yet.</p>
    <ul v-else class="divide-y divide-slate-100">
      <li
        v-for="it in items"
        :key="it.id"
        class="flex items-center justify-between py-2"
      >
        <span class="text-sm">{{ it.name }}</span>
        <button class="text-xs text-red-600 hover:underline" @click="removeItem(it.id)">
          delete
        </button>
      </li>
    </ul>
  </section>

  <p v-if="error" class="mt-6 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{{ error }}</p>
</template>
