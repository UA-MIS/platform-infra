import { Test } from '@nestjs/testing'
import type { INestApplication } from '@nestjs/common'
import request from 'supertest'
import { AppModule } from '../src/app.module'

// e2e tests proving the BACKEND CONTRACT without a database:
//   - GET /healthz is 200 and DB-independent (the chart probes hit this).
//   - the API is served under /api.
//   - data routes degrade to a clean 503 when DATABASE_URL is unset.
describe('backend contract (no DATABASE_URL)', () => {
  let app: INestApplication

  beforeAll(async () => {
    delete process.env.DATABASE_URL
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()
    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api', { exclude: ['healthz', '/'] })
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  it('GET / -> 200 running (not under /api)', async () => {
    const res = await request(app.getHttpServer()).get('/')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('running')
  })

  it('GET /healthz -> 200 ok (DB-independent)', async () => {
    const res = await request(app.getHttpServer()).get('/healthz')
    expect(res.status).toBe(200)
    expect(res.text).toBe('ok')
  })

  it('GET /api/health -> 200 unconfigured (DB-aware, under /api)', async () => {
    const res = await request(app.getHttpServer()).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.db).toBe('unconfigured')
  })

  it('GET /api/items -> 503 when DATABASE_URL is unset', async () => {
    const res = await request(app.getHttpServer()).get('/api/items')
    expect(res.status).toBe(503)
    expect(res.body.error).toContain('DATABASE_URL')
  })

  it('POST /api/items -> 503 when DATABASE_URL is unset', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/items')
      .send({ name: 'widget' })
    expect(res.status).toBe(503)
  })
})
