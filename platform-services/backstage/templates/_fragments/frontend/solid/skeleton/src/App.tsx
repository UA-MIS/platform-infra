import type { ParentProps } from 'solid-js'
import { A } from '@solidjs/router'

// Shared layout (the router `root`). The two pages render into props.children.
export default function App(props: ParentProps) {
  return (
    <div class="min-h-screen bg-slate-50 text-slate-900">
      <div class="mx-auto max-w-2xl px-4 py-10">
        <header class="mb-8">
          <h1 class="text-3xl font-bold tracking-tight">${{ values.appName }}</h1>
          {/* dump-quoted into a JSX expression container (task #11, D-112) -- raw JSX
             text breaks on '<' or '{'; a JS string literal inside {} is immune. */}
          <p class="mt-1 text-slate-600">{${{ values.description | dump }}}</p>
          <p class="mt-1 text-sm text-slate-500">
            SolidJS (Vite) frontend &middot; calls the backend API at <code>/api</code>.
          </p>
          <nav class="mt-4 flex gap-4 text-sm">
            <A
              href="/"
              end
              class="text-slate-700 hover:underline"
              activeClass="font-semibold text-slate-900"
            >
              Home
            </A>
            <A
              href="/about"
              class="text-slate-700 hover:underline"
              activeClass="font-semibold text-slate-900"
            >
              About
            </A>
          </nav>
        </header>

        {props.children}
      </div>
    </div>
  )
}
