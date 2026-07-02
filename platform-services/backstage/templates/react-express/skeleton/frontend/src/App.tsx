import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

// The frontend talks to the backend over the SAME origin under /api. In production the
// platform ingress routes /api -> the Express backend and / -> this SPA; in local dev the
// Vite proxy (vite.config.ts) forwards /api to the backend. So ALWAYS use a relative
// `/api/...` URL — never a hardcoded host.

type Health = {
  status: string
  db: string
  time: string
}

type Item = {
  id: number
  name: string
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function loadHealth() {
    try {
      const res = await fetch('/api/health')
      if (!res.ok) throw new Error('GET /api/health -> HTTP ' + res.status)
      setHealth(await res.json())
    } catch (e) {
      setError(String(e))
    }
  }

  async function loadItems() {
    try {
      const res = await fetch('/api/items')
      if (res.status === 503) {
        // DATABASE_URL not set yet — expected on a fresh repo. Show health, skip the list.
        setItems([])
        return
      }
      if (!res.ok) throw new Error('GET /api/items -> HTTP ' + res.status)
      const data = await res.json()
      setItems(data.items ?? [])
    } catch (e) {
      setError(String(e))
    }
  }

  async function addItem(e: FormEvent) {
    e.preventDefault()
    const value = name.trim()
    if (!value) return
    try {
      const res = await fetch('/api/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: value }),
      })
      if (!res.ok) throw new Error('POST /api/items -> HTTP ' + res.status)
      setName('')
      await loadItems()
    } catch (e) {
      setError(String(e))
    }
  }

  async function removeItem(id: number) {
    try {
      const res = await fetch('/api/items/' + id, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error('DELETE /api/items -> HTTP ' + res.status)
      await loadItems()
    } catch (e) {
      setError(String(e))
    }
  }

  useEffect(() => {
    setError(null)
    loadHealth()
    loadItems()
  }, [])

  const dbBadge =
    health?.db === 'up'
      ? 'bg-green-100 text-green-800'
      : health?.db === 'down'
        ? 'bg-red-100 text-red-800'
        : 'bg-amber-100 text-amber-800'

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">${{ values.appName }}</h1>
          <p className="mt-1 text-slate-600">${{ values.description }}</p>
          <p className="mt-1 text-sm text-slate-500">
            React (Vite) frontend &middot; calls the Express API at <code>/api</code>.
          </p>
        </header>

        <section className="mb-8 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-lg font-semibold">Backend health</h2>
          {health ? (
            <div className="flex items-center gap-3 text-sm">
              <span className="rounded bg-slate-100 px-2 py-1 font-mono">status: {health.status}</span>
              <span className={'rounded px-2 py-1 font-mono ' + dbBadge}>db: {health.db}</span>
              <span className="text-slate-500">{health.time}</span>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Contacting the backend…</p>
          )}
          {health?.db === 'unconfigured' && (
            <p className="mt-3 text-sm text-amber-700">
              No database configured. Add a <code>DATABASE_URL</code> secret via the
              Secrets tab in The Process to enable the items list below.
            </p>
          )}
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="mb-3 text-lg font-semibold">Items (sample CRUD)</h2>
          <form onSubmit={addItem} className="mb-4 flex gap-2">
            <input
              className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
              placeholder="New item name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <button
              type="submit"
              className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              Add
            </button>
          </form>

          {items.length === 0 ? (
            <p className="text-sm text-slate-500">No items yet.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {items.map((it) => (
                <li key={it.id} className="flex items-center justify-between py-2">
                  <span className="text-sm">{it.name}</span>
                  <button
                    onClick={() => removeItem(it.id)}
                    className="text-xs text-red-600 hover:underline"
                  >
                    delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {error && (
          <p className="mt-6 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}
      </div>
    </div>
  )
}
