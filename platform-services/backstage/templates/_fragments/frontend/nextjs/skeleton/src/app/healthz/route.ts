import { NextResponse } from 'next/server';

// GET /healthz — liveness/readiness probe. Returns 200 while the process is up and
// does NOT depend on the backend/API, so the pod becomes Ready independently of the
// backend component's own state. The .devops Deployment's probes hit this path
// directly on the pod (bypassing the Ingress) — see _contract/.devops/chart/base/
// deployments.yaml.
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ status: 'ok' }, { status: 200 });
}
