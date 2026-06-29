import { useState } from 'react'
import { Link } from 'react-router-dom'

// Home page. A tiny bit of state (the counter) proves React is wired and
// interactive — replace this with your own app.
export default function Home() {
  const [count, setCount] = useState(0)

  return (
    <section className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Welcome 👋</h1>
      <p className="text-slate-600">
        This is a static single-page app scaffolded by{' '}
        <span className="font-medium">The Process</span> — Vite + React +
        TypeScript + Tailwind, served by nginx. No backend, no database.
      </p>

      <button
        type="button"
        onClick={() => setCount((c) => c + 1)}
        className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white shadow-sm hover:bg-indigo-500"
      >
        Clicked {count} {count === 1 ? 'time' : 'times'}
      </button>

      <p className="text-sm text-slate-500">
        Edit <code className="rounded bg-slate-200 px-1">src/pages/Home.tsx</code>{' '}
        and the page hot-reloads. Visit the{' '}
        <Link to="/about" className="text-indigo-600 underline">
          About
        </Link>{' '}
        page to see client-side routing.
      </p>
    </section>
  )
}
