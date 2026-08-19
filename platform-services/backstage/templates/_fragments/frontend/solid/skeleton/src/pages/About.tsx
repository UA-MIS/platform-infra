// A second routed page, to demonstrate client-side routing (@solidjs/router). nginx falls
// back to index.html so /about resolves on a hard refresh too.
export default function About() {
  return (
    <section class="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <h2 class="mb-3 text-lg font-semibold">About ${{ values.appName }}</h2>
      {/* dump-quoted into a JSX expression container (task #11, D-112) -- see App.tsx. */}
      <p class="text-sm text-slate-600">{${{ values.description | dump }}}</p>
      <ul class="mt-4 list-disc space-y-1 pl-5 text-sm text-slate-600">
        <li>SolidJS single-page app, built with Vite and TypeScript.</li>
        <li>Styled with Tailwind CSS v4.</li>
        <li>Calls the backend over a relative <code>/api</code> URL (same origin).</li>
        <li>Served in production by hardened nginx (non-root, read-only rootfs).</li>
      </ul>
    </section>
  )
}
