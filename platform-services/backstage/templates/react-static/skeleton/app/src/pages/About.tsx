import { Link } from 'react-router-dom'

// A second routed page — demonstrates multi-page client-side navigation. Because
// this is a real URL (/about), nginx must fall back to index.html on a hard refresh;
// app/nginx.conf does exactly that (try_files ... /index.html).
export default function About() {
  return (
    <section className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">About</h1>
      <p className="text-slate-600">
        This starter ships the platform golden path: open a PR for a preview
        environment, merge to <code className="rounded bg-slate-200 px-1">main</code>{' '}
        for dev, tag <code className="rounded bg-slate-200 px-1">vX.Y.Z</code> for
        staging, and approve the manual gate for prod. You only edit{' '}
        <code className="rounded bg-slate-200 px-1">app/</code>.
      </p>
      <ul className="list-disc space-y-1 pl-6 text-slate-600">
        <li>Build tool: Vite</li>
        <li>UI: React + TypeScript</li>
        <li>Styling: Tailwind CSS</li>
        <li>Runtime: nginx (static files, non-root)</li>
      </ul>
      <Link to="/" className="inline-block text-indigo-600 underline">
        ← Back home
      </Link>
    </section>
  )
}
