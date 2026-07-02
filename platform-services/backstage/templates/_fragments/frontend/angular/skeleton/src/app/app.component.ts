import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { HttpClient } from '@angular/common/http';

// The frontend talks to the backend over the SAME origin under /api. In a frontend+backend
// project the platform ingress routes /api -> the backend and / -> this SPA; in local dev
// proxy /api to the backend. So ALWAYS use a relative `/api/...` URL — never a hardcoded
// host. Composed in the `single` slot (no backend), the health call simply fails gracefully.
interface Health {
  status: string;
  db: string;
  time: string;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="min-h-screen bg-slate-50 text-slate-900">
      <header class="border-b border-slate-200 bg-white">
        <nav class="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
          <span class="text-lg font-bold tracking-tight">${{ values.appName }}</span>
          <div class="flex gap-6">
            <a
              routerLink="/"
              routerLinkActive="font-semibold text-indigo-600"
              [routerLinkActiveOptions]="{ exact: true }"
              class="text-slate-600 hover:text-slate-900"
              >Home</a
            >
            <a
              routerLink="/about"
              routerLinkActive="font-semibold text-indigo-600"
              class="text-slate-600 hover:text-slate-900"
              >About</a
            >
          </div>
        </nav>
      </header>

      <main class="mx-auto max-w-3xl px-4 py-10">
        <section class="mb-8 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 class="mb-3 text-lg font-semibold">Backend health</h2>
          @if (health()) {
            <div class="flex items-center gap-3 text-sm">
              <span class="rounded bg-slate-100 px-2 py-1 font-mono">status: {{ health()!.status }}</span>
              <span class="rounded bg-slate-100 px-2 py-1 font-mono">db: {{ health()!.db }}</span>
              <span class="text-slate-500">{{ health()!.time }}</span>
            </div>
          } @else {
            <p class="text-sm text-slate-500">{{ error() ?? 'Contacting the backend…' }}</p>
          }
        </section>

        <router-outlet />
      </main>
    </div>
  `,
})
export class AppComponent implements OnInit {
  private readonly http = inject(HttpClient);
  readonly health = signal<Health | null>(null);
  readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.http.get<Health>('/api/health').subscribe({
      next: (h) => this.health.set(h),
      error: () =>
        this.error.set(
          'Backend /api not reachable — standalone mode (compose with a backend to enable).',
        ),
    });
  }
}
