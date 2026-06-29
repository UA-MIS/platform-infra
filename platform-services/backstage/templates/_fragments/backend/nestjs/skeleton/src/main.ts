import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

// Entry point. The platform chart injects PORT (from this component's port in
// components.yaml); honor it, defaulting to 8080. The API is served under a global
// "/api" prefix so the ingress "/api" route reaches it in a frontend+backend app;
// /healthz is EXCLUDED from the prefix so the chart's DB-independent probe hits it at the
// root. (The DB-aware /api/health convenience route stays under the prefix.)
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  app.setGlobalPrefix('api', { exclude: ['healthz'] })

  const port = Number(process.env.PORT) || 8080
  await app.listen(port, '0.0.0.0')
  console.log('backend listening on :' + port)
}

void bootstrap()
