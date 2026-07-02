import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

// A second routed page — demonstrates multi-page client-side navigation. Because this is a
// real URL (/about), nginx must fall back to index.html on a hard refresh; nginx.conf does
// exactly that (try_files ... /index.html).
@Component({
  selector: 'app-about',
  standalone: true,
  imports: [RouterLink],
  template: `
    <section class="space-y-6">
      <h1 class="text-3xl font-bold tracking-tight">About</h1>
      <p class="text-slate-600">
        This starter ships the platform golden path: open a PR for a preview environment,
        merge to <code class="rounded bg-slate-200 px-1">main</code> for dev, tag
        <code class="rounded bg-slate-200 px-1">vX.Y.Z</code> for staging, and approve the
        manual gate for prod. You only edit the app source.
      </p>
      <ul class="list-disc space-y-1 pl-6 text-slate-600">
        <li>Framework: Angular + TypeScript</li>
        <li>Styling: Tailwind CSS</li>
        <li>Runtime: nginx (static files, non-root)</li>
        <li>Backend: relative <code class="rounded bg-slate-200 px-1">/api</code> calls</li>
      </ul>
      <a routerLink="/" class="inline-block text-indigo-600 underline">← Back home</a>
    </section>
  `,
})
export class AboutComponent {}
