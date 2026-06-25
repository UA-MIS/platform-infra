/*
 * `capstone:seal-secret` — the M3 secrets scaffolder action (plan §2, §3; reworked for the
 * ESO+Vault v1 model, ADR-030 B1).
 *
 * This is a THIN caller of sealCore.sealAndPublish (src/sealCore.ts) — the ONE shared
 * implementation also used by the capstone-secrets backend route the frontend posts to. So the
 * action and the route enforce the SAME `capstone.secret.seal` authz + owner re-check +
 * fail-closed + write-to-Vault-then-commit-ExternalSecret invariants; neither is a softer
 * back-door (ADR-029 §6). The value lands ONLY in Vault — nothing secret is committed to git.
 *
 * The action exists so the secrets capability is ALSO usable from a scaffolder Template step
 * (e.g. M4 onboarding could set a bootstrap secret); the frontend Secrets page uses the route.
 * The id stays `capstone:seal-secret` for backward compatibility with existing templates.
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
      'Set a team secret: write the value to Vault (ESO model) and open a PR committing an ' +
      'ExternalSecret declaration (key names only) to the team app repo. Write-only: ' +
      'values cannot be read back.',
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
              'The secret value (plaintext). Written to Vault immediately; never committed ' +
              'to git or logged.',
          }),
        envs: z =>
          z
            .array(z.enum(['dev', 'staging', 'prod']))
            .min(1)
            .describe(
              'Target environments to set for (dev, staging, and/or prod). ' +
                'Preview (ephemeral pr-<n>) namespaces are out of scope.',
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
