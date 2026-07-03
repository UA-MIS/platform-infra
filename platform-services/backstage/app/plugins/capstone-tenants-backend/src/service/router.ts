/*
 * The capstone-tenants backend route — what the admin Tenant Teardown page calls.
 *
 *   GET  /tenants                              -> { tenants: [{name, team, appName, semester, ...}] }
 *   POST /teardown  { name, confirmName, archiveRepo } -> { pullRequestUrl, claimPath, repoArchived }
 *
 * SECURITY: every request resolves the AUTHENTICATED USER's credentials (httpAuth, allow:
 * ['user'] only — no service principal can drive teardown) and passes them into teardownCore,
 * which enforces ADMIN-ONLY authz (capstone.tenant.teardown + belt-and-suspenders admin-group
 * re-check, fail-closed). The route holds NO authz logic — it delegates to the one shared core,
 * exactly like the capstone-secrets route delegates to sealCore. POST (not DELETE) for /teardown
 * so the {name,confirmName} body parses reliably across clients/proxies.
 */
import { HttpAuthService } from '@backstage/backend-plugin-api';
import { InputError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import {
  listTenants,
  teardownTenant,
  type CapstoneTenantsDeps,
} from '@internal/backstage-plugin-scaffolder-backend-module-capstone';

export async function createRouter(
  deps: CapstoneTenantsDeps & { httpAuth: HttpAuthService },
): Promise<express.Router> {
  const { httpAuth, ...core } = deps;
  const router = Router();
  router.use(express.json());

  // GET /tenants — list the live CapstoneTenant claims (admin-only, enforced in the core).
  router.get('/tenants', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const tenants = await listTenants(core, { credentials });
    res.json({ tenants });
  });

  // POST /teardown — open the PR removing the claim file (+ optional repo archive). Admin-only.
  router.post('/teardown', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { name, confirmName, archiveRepo } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim()) {
      throw new InputError('name is required');
    }
    if (typeof confirmName !== 'string' || !confirmName.trim()) {
      throw new InputError('confirmName is required (type the tenant name to confirm)');
    }
    if (archiveRepo !== undefined && typeof archiveRepo !== 'boolean') {
      throw new InputError('archiveRepo must be a boolean');
    }
    const result = await teardownTenant(core, {
      credentials,
      name,
      confirmName,
      archiveRepo: archiveRepo === true,
    });
    res.json(result);
  });

  return router;
}
