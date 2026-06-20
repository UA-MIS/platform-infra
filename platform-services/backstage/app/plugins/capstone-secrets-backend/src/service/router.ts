/*
 * The capstone-secrets backend route — what the frontend Secrets page posts to.
 *
 *   POST /seal   { entityRef, key, value, envs[] }  -> { pullRequestUrls[] }
 *   GET  /list?entityRef=...                          -> { secrets: [{key, env, lastUpdated}] }
 *
 * SECURITY: every request resolves the AUTHENTICATED USER's credentials (httpAuth, allow:
 * ['user'] only — no service principal can drive this) and passes them into sealCore, which
 * enforces the SAME capstone.secret.seal authz + owner-intersection + fail-closed as the
 * scaffolder action (team-lead requirement: the route is NOT a softer back-door). The route
 * itself holds no authz logic — it delegates to the one shared core. The value is never
 * logged here and is forwarded straight into the seal-and-discard path.
 */
import { HttpAuthService } from '@backstage/backend-plugin-api';
import { InputError } from '@backstage/errors';
import express from 'express';
import Router from 'express-promise-router';
import {
  listSecrets,
  sealAndPublish,
  type CapstoneSecretsDeps,
} from '@internal/backstage-plugin-scaffolder-backend-module-capstone';

const VALID_ENVS = ['dev', 'staging', 'prod'];

export async function createRouter(
  deps: CapstoneSecretsDeps & { httpAuth: HttpAuthService },
): Promise<express.Router> {
  const { httpAuth, ...core } = deps;
  const router = Router();
  router.use(express.json());

  // POST /seal — seal + open PR(s). User credentials only; sealCore enforces authz.
  router.post('/seal', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { entityRef, key, value, envs } = req.body ?? {};

    if (typeof entityRef !== 'string' || !entityRef) {
      throw new InputError('entityRef is required');
    }
    if (typeof key !== 'string' || !key.trim()) {
      throw new InputError('key is required');
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new InputError('value is required');
    }
    if (
      !Array.isArray(envs) ||
      envs.length === 0 ||
      !envs.every(e => VALID_ENVS.includes(e))
    ) {
      throw new InputError(
        `envs must be a non-empty subset of ${VALID_ENVS.join(', ')}`,
      );
    }

    const result = await sealAndPublish(core, {
      credentials,
      entityRef,
      key,
      value,
      envs,
    });
    res.json(result);
  });

  // GET /list — key names + env + last-updated, NEVER values. Same authz as seal.
  router.get('/list', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const entityRef = req.query.entityRef;
    if (typeof entityRef !== 'string' || !entityRef) {
      throw new InputError('entityRef query parameter is required');
    }
    const secrets = await listSecrets(core, { credentials, entityRef });
    res.json({ secrets });
  });

  return router;
}
