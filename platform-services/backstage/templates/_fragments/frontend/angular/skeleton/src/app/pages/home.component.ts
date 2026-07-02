import { Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

// Home page. A tiny bit of state (the counter) proves Angular is wired and interactive —
// replace this with your own app.
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [RouterLink],
  template: `
    <section class="space-y-6">
      <h1 class="text-3xl font-bold tracking-tight">Welcome 👋</h1>
      <p class="text-slate-600">${{ values.description }}</p>
      <p class="text-slate-600">
        An Angular single-page app scaffolded by <span class="font-medium">The Process</span> —
        TypeScript + Tailwind, served by nginx. It calls the backend over a relative
        <code class="rounded bg-slate-200 px-1">/api</code> URL.
      </p>

      <button
        type="button"
        (click)="count.set(count() + 1)"
        class="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white shadow-sm hover:bg-indigo-500"
      >
        Clicked {{ count() }} {{ count() === 1 ? 'time' : 'times' }}
      </button>

      <p class="text-sm text-slate-500">
        Visit the <a routerLink="/about" class="text-indigo-600 underline">About</a> page to see
        client-side routing (nginx falls back to index.html for deep links).
      </p>
    </section>
  `,
})
export class HomeComponent {
  readonly count = signal(0);
}
