/*
 * Router tests for the capstone-secrets backend route. The seal/authz LOGIC is tested in the
 * scaffolder module (sealCore is mocked here); these tests guard the HTTP CONTRACT:
 *  - POST /seal forwards {entityRef,key,value,envs} + the authenticated user's credentials to
 *    sealAndPublish and returns its PR URLs,
 *  - input validation (missing fields, bad envs) -> 400,
 *  - GET /list forwards entityRef and returns the (write-only) summaries,
 *  - both require an authenticated USER principal (httpAuth allow:['user']).
 */
import express from 'express';
import request from 'supertest';
import { mockServices } from '@backstage/backend-test-utils';
import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';

const sealAndPublish = jest.fn();
const listSecrets = jest.fn();
jest.mock('@internal/backstage-plugin-scaffolder-backend-module-capstone', () => ({
  sealAndPublish: (...args: unknown[]) => sealAndPublish(...args),
  listSecrets: (...args: unknown[]) => listSecrets(...args),
}));

// eslint-disable-next-line import/first
import { createRouter } from './router';

async function buildApp() {
  const router = await createRouter({
    httpAuth: mockServices.httpAuth(),
    config: mockServices.rootConfig(),
    logger: mockServices.logger.mock(),
    permissions: mockServices.permissions.mock() as any,
    auth: mockServices.auth(),
    catalog: {} as any,
  });
  const app = express();
  app.use(router);
  // Apply the same error middleware the real backend wraps plugin routers with, so
  // InputError -> 400 (etc.) exactly as in production (not a bare 500).
  const config = mockServices.rootConfig();
  app.use(
    MiddlewareFactory.create({ config, logger: mockServices.logger.mock() }).error(),
  );
  return app;
}

beforeEach(() => {
  sealAndPublish.mockReset();
  listSecrets.mockReset();
});

describe('capstone-secrets router', () => {
  describe('POST /seal', () => {
    it('forwards the request + credentials to sealAndPublish and returns PR URLs', async () => {
      sealAndPublish.mockResolvedValue({
        pullRequestUrls: ['https://github.com/x/y/pull/1'],
      });
      const app = await buildApp();

      const res = await request(app)
        .post('/seal')
        .send({
          entityRef: 'component:default/my-app',
          key: 'DATABASE_URL',
          value: 'super-secret',
          envs: ['dev', 'prod'],
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        pullRequestUrls: ['https://github.com/x/y/pull/1'],
      });
      // The core got the request fields + an actor credentials object.
      expect(sealAndPublish).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          entityRef: 'component:default/my-app',
          key: 'DATABASE_URL',
          value: 'super-secret',
          envs: ['dev', 'prod'],
          credentials: expect.anything(),
        }),
      );
    });

    it('400s when required fields are missing (no seal attempted)', async () => {
      const app = await buildApp();
      const res = await request(app)
        .post('/seal')
        .send({ entityRef: 'component:default/my-app', envs: ['dev'] });
      expect(res.status).toBe(400);
      expect(sealAndPublish).not.toHaveBeenCalled();
    });

    it('400s on an invalid env (no seal attempted)', async () => {
      const app = await buildApp();
      const res = await request(app).post('/seal').send({
        entityRef: 'component:default/my-app',
        key: 'K',
        value: 'v',
        envs: ['preview'],
      });
      expect(res.status).toBe(400);
      expect(sealAndPublish).not.toHaveBeenCalled();
    });
  });

  describe('GET /list', () => {
    it('forwards entityRef and returns the write-only summaries', async () => {
      listSecrets.mockResolvedValue([
        { key: 'DATABASE_URL', env: 'dev', lastUpdated: '2026-06-19T00:00:00Z' },
      ]);
      const app = await buildApp();
      const res = await request(app)
        .get('/list')
        .query({ entityRef: 'component:default/my-app' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        secrets: [
          {
            key: 'DATABASE_URL',
            env: 'dev',
            lastUpdated: '2026-06-19T00:00:00Z',
          },
        ],
      });
      expect(listSecrets).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ entityRef: 'component:default/my-app' }),
      );
    });

    it('400s without entityRef', async () => {
      const app = await buildApp();
      const res = await request(app).get('/list');
      expect(res.status).toBe(400);
      expect(listSecrets).not.toHaveBeenCalled();
    });
  });
});
