import { Controller, Get, Header } from '@nestjs/common'

// Liveness/readiness probe controller. /healthz and / are both EXCLUDED from the global
// "/api" prefix (see main.ts) so they live at the root; /healthz is kept INDEPENDENT of the
// database so the pod stays Ready even when DATABASE_URL is unset/unreachable. (The DB-aware
// health summary is /api/health in ItemsController.)
@Controller()
export class HealthController {
  @Get('healthz')
  @Header('Content-Type', 'text/plain')
  healthz(): string {
    return 'ok'
  }

  // So a student's first visit to the app's own URL isn't a 404. API-only backend: no UI
  // lives here (a fullstack layout's frontend owns "/" instead).
  @Get()
  root(): { service: string; status: string; hints: string[] } {
    return {
      service: '${{ values.appName }}',
      status: 'running',
      hints: ['/healthz', '/api/health', '/api/items'],
    }
  }
}
