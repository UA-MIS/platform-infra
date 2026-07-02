# ${{ values.appName }}

${{ values.description }}

A static single-page app (Vite + React + TypeScript + Tailwind, served by nginx) on the
UA-MIS capstone platform golden path. Cohort: **${{ values.semesterDisplay }}**.

## What this is

- **Front-end only.** No backend service, no database. The build produces static files
  (`dist/`) that nginx serves.
- **Golden path.** Open a PR → preview; merge to `main` → dev; tag `vX.Y.Z` → staging;
  approve the gate → prod.
- **You edit `app/`.** Everything under `.devops/` is platform-managed.

## Local development

```bash
cd app
npm install
npm run dev      # http://localhost:5173 (hot reload)
npm run build    # production build -> app/dist
npm run preview  # serve the production build locally
```

## Structure

| Path | Purpose |
| --- | --- |
| `app/src/main.tsx` | Entry point — mounts React + `BrowserRouter`. |
| `app/src/App.tsx` | Route table + app shell. |
| `app/src/pages/` | One component per route (`Home`, `About`, `NotFound`). |
| `app/src/components/` | Shared UI (e.g. `NavBar`). |
| `app/Dockerfile` | Multi-stage build (node → nginx, non-root). |
| `app/nginx.conf` | SPA fallback routing + `/healthz`. |

## Routing

Client-side routing via React Router. nginx serves `index.html` for unknown paths
(`try_files ... /index.html`), so deep links and hard refreshes work. Add a page by
creating a component in `src/pages/` and a `<Route>` in `App.tsx`.

## Styling

Tailwind CSS v4 via the `@tailwindcss/vite` plugin. There is no `tailwind.config.js`;
Tailwind scans your source for class names, and `src/index.css` contains the single
`@import "tailwindcss";`. Use utility classes directly in your JSX.

## Configuration

Static SPAs have no runtime secrets. For build-time config, use Vite env vars
(`VITE_`-prefixed, read via `import.meta.env`). These are **public** in the bundle —
never store a real secret there.

## Deployment targets

| Environment | URL |
| --- | --- |
| dev | `https://${{ values.appName }}.dev.capstone.uamishub.com` |
| staging | `https://${{ values.appName }}.staging.capstone.uamishub.com` |
| prod | `https://${{ values.appName }}.capstone.uamishub.com` |
