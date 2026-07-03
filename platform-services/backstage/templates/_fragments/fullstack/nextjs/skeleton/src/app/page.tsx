import Link from 'next/link';

// The home page is static (no database access), so a freshly-scaffolded app renders
// even before DATABASE_URL is set. It is the liveness target for `GET /` if you want
// one; the kubelet probes hit /healthz (see app/src/app/healthz/route.ts).
export default function HomePage() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">${{ values.appName }}</h1>
      <p className="mt-2 text-gray-600">${{ values.description }}</p>

      <p className="mt-6 text-gray-700">
        A Next.js (App Router, TypeScript) starter wired to MySQL via Prisma and
        styled with Tailwind, scaffolded by The Process onto the UA-MIS capstone
        golden path. Edit <code className="rounded bg-gray-100 px-1">src/app</code>{' '}
        to build your app.
      </p>

      <ul className="mt-6 space-y-2">
        <li>
          <Link href="/notes" className="text-blue-600 underline">
            Notes
          </Link>{' '}
          — a page that reads rows from MySQL through Prisma.
        </li>
        <li>
          <code className="rounded bg-gray-100 px-1">GET/POST /api/notes</code> — a
          sample JSON API route backed by Prisma.
        </li>
        <li>
          <code className="rounded bg-gray-100 px-1">GET /healthz</code> — the
          liveness/readiness probe (always 200).
        </li>
      </ul>

      <p className="mt-8 text-sm text-gray-500">
        Set <code>DATABASE_URL</code> in the Secrets tab — your migrations run
        automatically on the next deploy and create your tables.
      </p>
    </main>
  );
}
