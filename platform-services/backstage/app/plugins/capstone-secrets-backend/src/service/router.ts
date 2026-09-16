/*
 * The capstone-secrets backend route — what the frontend Secrets page posts to.
 *
 *   POST /seal    { entityRef, key, value, envs[] } -> { pullRequestUrls[] }
 *   GET  /list?entityRef=...                         -> { secrets: [{key, env, lastUpdated}],
 *                                                        environments: [{env, declaredKeyCount, lastUpdated}] }
 *   GET  /my-projects                                -> { projects: [{entityRef, title, owner}] }
 *   POST /delete  { entityRef, key, env }            -> { pullRequestUrl }  (un-seal, ONE env)
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
  listMyProjects,
  sealAndPublish,
  deleteSecret,
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
    // { secrets, environments } — `environments` lets the UI distinguish "this env is
    // configured but has no secrets yet" from "this env does not exist for this app".
    res.json(await listSecrets(core, { credentials, entityRef }));
  });

  // GET /my-projects — the access-scoped project picker (Components the user owns; labmx=all).
  router.get('/my-projects', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const projects = await listMyProjects(core, { credentials });
    res.json({ projects });
  });

  // POST /delete — un-seal a key (PR removing the file + overlay refs). Same authz as seal.
  // POST (not DELETE) so the {entityRef,key} body parses reliably across clients/proxies.
  router.post('/delete', async (req, res) => {
    const credentials = await httpAuth.credentials(req, { allow: ['user'] });
    const { entityRef, key, env } = req.body ?? {};
    if (typeof entityRef !== 'string' || !entityRef) {
      throw new InputError('entityRef is required');
    }
    // REQUIRED, and rejected rather than defaulted. Before the 2026-09-16 mychef incident
    // this route took no env and sealCore deleted from EVERY environment that declared the
    // key — one click on the tab's `dev` row destroyed that team's production secret. A
    // missing env must be a 400, never "all of them".
    if (typeof env !== 'string' || !VALID_ENVS.includes(env)) {
      throw new InputError(
        `env is required and must be one of ${VALID_ENVS.join(', ')} — a secret is ` +
          `deleted from exactly one environment at a time`,
      );
    }
    if (typeof key !== 'string' || !key.trim()) {
      throw new InputError('key is required');
    }
    const result = await deleteSecret(core, { credentials, entityRef, key, env });
    res.json(result);
  });

  return router;
}
