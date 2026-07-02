import { Controller, Get, Header } from '@nestjs/common'

// Liveness/readiness probe controller. /healthz is EXCLUDED from the global "/api" prefix
// (see main.ts) so it lives at the root, and it is kept INDEPENDENT of the database so the
// pod stays Ready even when DATABASE_URL is unset/unreachable. (The DB-aware health summary
// is /api/health in ItemsController.)
@Controller()
export class HealthController {
  @Get('healthz')
  @Header('Content-Type', 'text/plain')
  healthz(): string {
    return 'ok'
  }
}
