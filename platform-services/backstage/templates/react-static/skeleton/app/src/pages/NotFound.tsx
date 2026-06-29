import { Link } from 'react-router-dom'

// Catch-all client route. Note: nginx still returns HTTP 200 + index.html for
// unknown paths (SPA fallback), and THIS component renders the "not found" UI —
// that is the conventional SPA pattern (the 404 is a client concern, not a server one).
export default function NotFound() {
  return (
    <section className="space-y-4 text-center">
      <h1 className="text-5xl font-bold tracking-tight">404</h1>
      <p className="text-slate-600">That page does not exist.</p>
      <Link to="/" className="inline-block text-indigo-600 underline">
        ← Back home
      </Link>
    </section>
  )
}
