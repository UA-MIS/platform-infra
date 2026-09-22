'use client';

import { useEffect, useState } from 'react';

// The frontend talks to the backend over the SAME origin under /api. In production the
// platform ingress routes /api -> the backend component and / -> this Next.js server;
// in local dev, run the backend separately and reach it through a dev proxy, or just
// hit its own port directly while iterating. ALWAYS use a relative `/api/...` URL —
// never a hardcoded host (same convention as frontend/react's App.tsx).
type Health = {
  status: string;
};

export default function HomePage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/health')
      .then((res) => {
        if (!res.ok) throw new Error('GET /api/health -> HTTP ' + res.status);
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setHealth(data);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">${{ values.appName }}</h1>
      <p className="mt-2 text-gray-600">{${{ values.description | dump }}}</p>

      <p className="mt-6 text-gray-700">
        A Next.js (App Router, TypeScript) server frontend, styled with Tailwind,
        scaffolded onto the UA-MIS capstone golden path. It owns{' '}
        <code className="rounded bg-gray-100 px-1">/</code>; its paired backend owns{' '}
        <code className="rounded bg-gray-100 px-1">/api</code>.
      </p>

      <section className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <h2 className="text-lg font-semibold">Backend health</h2>
        {health ? (
          <p className="mt-1 font-mono text-sm">status: {health.status}</p>
        ) : error ? (
          <p className="mt-1 text-sm text-red-700">{error}</p>
        ) : (
          <p className="mt-1 text-sm text-gray-500">Contacting the backend…</p>
        )}
      </section>

      <p className="mt-8 text-sm text-gray-500">
        <code className="rounded bg-gray-100 px-1">GET /healthz</code> — this
        component&apos;s own liveness/readiness probe (always 200).
      </p>
    </main>
  );
}
