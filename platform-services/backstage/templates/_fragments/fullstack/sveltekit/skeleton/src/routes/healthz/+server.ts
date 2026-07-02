import { json } from '@sveltejs/kit'

// GET /healthz — liveness/readiness probe. Returns 200 while the process is up and does
// NOT touch the database or any config, so the pod becomes Ready even before DATABASE_URL
// is set. The platform chart's readiness/liveness probes target this path.
export const GET = () => json({ status: 'ok' }, { status: 200 })
