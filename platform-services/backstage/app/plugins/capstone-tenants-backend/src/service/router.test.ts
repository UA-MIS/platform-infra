/*
 * Router tests for the capstone-tenants backend route. The authz/teardown LOGIC lives in
 * teardownCore (mocked here); these guard the HTTP CONTRACT:
 *  - GET /tenants forwards the authenticated user's credentials to listTenants and returns them,
 *  - POST /teardown forwards {name,confirmName,archiveRepo} + credentials to teardownTenant,
 *  - input validation (missing name/confirmName, non-boolean archiveRepo) -> 400,
 *  - both require an authenticated USER principal (httpAuth allow:['user']).
 */
import express from 'express';
import request from 'supertest';
import { mockServices } from '@backstage/backend-test-utils';
import { MiddlewareFactory } from '@backstage/backend-defaults/rootHttpRouter';

const listTenants = jest.fn();
const teardownTenant = jest.fn();
jest.mock('@internal/backstage-plugin-scaffolder-backend-module-capstone', () => ({
  listTenants: (...args: unknown[]) => listTenants(...args),
  teardownTenant: (...args: unknown[]) => teardownTenant(...args),
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
  const config = mockServices.rootConfig();
  app.use(
    MiddlewareFactory.create({ config, logger: mockServices.logger.mock() }).error(),
  );
  return app;
}

beforeEach(() => {
  listTenants.mockReset();
  teardownTenant.mockReset();
});

describe('capstone-tenants router', () => {
  describe('GET /tenants', () => {
    it('returns the list from listTenants', async () => {
      listTenants.mockResolvedValue([
        { name: 'swami-swamiapp', team: 'swami', appName: 'swamiapp', semester: '2026-summer', claimPath: 'x' },
      ]);
      const app = await buildApp();
      const res = await request(app).get('/tenants');
      expect(res.status).toBe(200);
      expect(res.body.tenants).toHaveLength(1);
      expect(res.body.tenants[0].name).toBe('swami-swamiapp');
      // Credentials were forwarded (mockServices.httpAuth resolves a user principal).
      expect(listTenants).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ credentials: expect.any(Object) }),
      );
    });
  });

  describe('POST /teardown', () => {
    it('forwards {name,confirmName,archiveRepo} + credentials and returns the result', async () => {
      teardownTenant.mockResolvedValue({
        pullRequestUrl: 'https://github.com/UA-MIS/platform-infra/pull/9',
        claimPath: 'tenants/_claims/swami-swamiapp.yaml',
        repoArchived: true,
      });
      const app = await buildApp();
      const res = await request(app)
        .post('/teardown')
        .send({ name: 'swami-swamiapp', confirmName: 'swami-swamiapp', archiveRepo: true });

      expect(res.status).toBe(200);
      expect(res.body.pullRequestUrl).toContain('/pull/9');
      expect(teardownTenant).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          name: 'swami-swamiapp',
          confirmName: 'swami-swamiapp',
          archiveRepo: true,
        }),
      );
    });

    it('defaults archiveRepo to false when omitted', async () => {
      teardownTenant.mockResolvedValue({
        pullRequestUrl: 'https://x/pull/1',
        claimPath: 'p',
        repoArchived: false,
      });
      const app = await buildApp();
      await request(app)
        .post('/teardown')
        .send({ name: 'a-b', confirmName: 'a-b' });
      expect(teardownTenant).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ archiveRepo: false }),
      );
    });

    it('400s when name is missing', async () => {
      const app = await buildApp();
      const res = await request(app)
        .post('/teardown')
        .send({ confirmName: 'x' });
      expect(res.status).toBe(400);
      expect(teardownTenant).not.toHaveBeenCalled();
    });

    it('400s when confirmName is missing', async () => {
      const app = await buildApp();
      const res = await request(app).post('/teardown').send({ name: 'a-b' });
      expect(res.status).toBe(400);
      expect(teardownTenant).not.toHaveBeenCalled();
    });

    it('400s when archiveRepo is not a boolean', async () => {
      const app = await buildApp();
      const res = await request(app)
        .post('/teardown')
        .send({ name: 'a-b', confirmName: 'a-b', archiveRepo: 'yes' });
      expect(res.status).toBe(400);
      expect(teardownTenant).not.toHaveBeenCalled();
    });
  });
});
