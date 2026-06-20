/*
 * `capstone:seal-secret` — the M3 secrets sealing scaffolder action (plan §2, §3).
 *
 * This is a THIN caller of sealCore.sealAndPublish (src/sealCore.ts) — the ONE shared
 * implementation also used by the capstone-secrets backend route the frontend posts to. So the
 * action and the route enforce the SAME `capstone.secret.seal` authz + owner re-check +
 * fail-closed + offline-seal-via-stdin invariants; neither is a softer back-door (ADR-029 §6).
 *
 * The action exists so the seal capability is ALSO usable from a scaffolder Template step (e.g.
 * M4 onboarding could seal a bootstrap secret); the frontend Secrets page uses the route.
 */
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import {
  sealAndPublish,
  type CapstoneSecretsDeps,
} from '../sealCore';

export { ADMIN_GROUP_REF } from '../sealCore';

/** Services the action handler needs, injected from the module's registerInit (plan §3). */
export type SealSecretActionDeps = CapstoneSecretsDeps;

/**
 * Factory for the `capstone:seal-secret` action. Takes its service deps so the module wires
 * them in at registration (createBackendModule registerInit), keeping the action unit-
 * testable with mocks.
 */
export function createSealSecretAction(deps: SealSecretActionDeps) {
  return createTemplateAction({
    id: 'capstone:seal-secret',
    description:
      'Seal a team secret (kubeseal, offline cert) and open a PR committing the ' +
      'SealedSecret to the team app repo. Write-only: values cannot be read back.',
    schema: {
      input: {
        entityRef: z =>
          z.string({
            description:
              'Catalog entity ref of the target Component (e.g. component:default/my-app).',
          }),
        key: z =>
          z.string({
            description: 'The secret key/name (e.g. DATABASE_URL).',
          }),
        value: z =>
          z.string({
            description:
              'The secret value (plaintext). Sealed immediately; never stored or logged.',
          }),
        envs: z =>
          z
            .array(z.enum(['dev', 'staging', 'prod']))
            .min(1)
            .describe(
              'Target environments to seal for (dev, staging, and/or prod). ' +
                'Preview (ephemeral pr-<n>) namespaces are out of scope — strict scope ' +
                'cannot pre-seal for an unknown namespace.',
            ),
      },
      output: {
        pullRequestUrls: z =>
          z
            .array(z.string())
            .describe('The opened pull request URL(s), one per env.'),
      },
    },
    async handler(ctx) {
      const { entityRef, key, value, envs } = ctx.input;
      const credentials = await ctx.getInitiatorCredentials();
      const { pullRequestUrls } = await sealAndPublish(deps, {
        credentials,
        entityRef,
        key,
        value,
        envs,
      });
      ctx.output('pullRequestUrls', pullRequestUrls);
    },
  });
}
