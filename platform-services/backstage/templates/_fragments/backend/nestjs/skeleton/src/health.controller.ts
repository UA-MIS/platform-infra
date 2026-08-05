import { createHash } from 'crypto'
import { Controller, Get, Header } from '@nestjs/common'

// Liveness/readiness probe controller. /healthz is EXCLUDED from the global "/api" prefix
// (see main.ts) so it lives at the root, and it is kept INDEPENDENT of the database so the
// pod stays Ready even when DATABASE_URL is unset/unreachable. (The DB-aware health summary
// is /api/health in ItemsController.)
//
// The bare "/" route is ALSO excluded from the prefix (see main.ts) so a single-component
// backend (no frontend) doesn't 404 on its own homepage; it proves APP_SECRET was read
// WITHOUT echoing it.
@Controller()
export class HealthController {
  @Get('healthz')
  @Header('Content-Type', 'text/plain')
  healthz(): string {
    return 'ok'
  }

  @Get()
  root() {
    const secret = process.env.APP_SECRET ?? ''
    return {
      app: '${{ values.appName }}',
      secret_loaded: secret.length > 0,
      secret_length: secret.length,
      secret_sha256_prefix: createHash('sha256').update(secret).digest('hex').slice(0, 8),
    }
  }
}
