import { NextResponse } from 'next/server';

// GET /healthz — liveness/readiness probe. Returns 200 while the process is up and
// does NOT depend on the database or any config, so the pod becomes Ready even before
// DATABASE_URL is set. The .devops Deployment's readiness/liveness probes target this.
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ status: 'ok' }, { status: 200 });
}
