/*
 * `capstone:seal-secret` — the M3 secrets sealing scaffolder action (plan §2, §3).
 *
 * Flow (handler): authorize the actor for `capstone.secret.seal` (+ a belt-and-suspenders
 * owner re-check) -> for each target env, build a k8s Secret manifest IN MEMORY -> seal it
 * by shelling out to the bundled `kubeseal` binary against the EXPORTED OFFLINE public cert
 * (D-047 A2: no controller egress), with the plaintext piped to kubeseal STDIN (never a
 * tempfile, never logged) -> open a PR to the team's app repo committing the SealedSecret at
 * `.devops/secrets/<key>.sealedsecret.yaml` (+ append it to the env overlay kustomization).
 *
 * SECURITY INVARIANTS (plan R2 — security review focus):
 *   - the plaintext VALUE is piped to kubeseal stdin; it is NEVER written to a tempfile and
 *     NEVER passed as an argv (execFile, not a shell) so it can't leak via process listings.
 *   - the VALUE never reaches ctx.logger or any thrown error string (only the KEY + env).
 *   - the action fails CLOSED on an authz miss: no kubeseal invocation, no Octokit call.
 *
 * SKELETON NOTE (M3-T2): this file currently registers the action shape only. The handler
 * body (sealing + Octokit PR) is implemented in M3-T4; the authorize/owner-recheck in M3-T5.
 */
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import type { AuthService, LoggerService } from '@backstage/backend-plugin-api';
import type { PermissionsService } from '@backstage/backend-plugin-api';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import type { Config } from '@backstage/config';

/** Services the action handler needs, injected from the module's registerInit (plan §3). */
export interface SealSecretActionDeps {
  config: Config;
  logger: LoggerService;
  catalog: CatalogService;
  permissions: PermissionsService;
  auth: AuthService;
}

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
        // The catalog Component entity ref the secret belongs to; the team that owns it is
        // the authorization subject and its source repo is the PR target.
        entityRef: z =>
          z.string({
            description:
              'Catalog entity ref of the target Component (e.g. component:default/my-app).',
          }),
        // The secret key (becomes the SealedSecret name + the data key + the filename).
        key: z =>
          z.string({
            description: 'The secret key/name (e.g. DATABASE_URL).',
          }),
        // The plaintext value. NEVER logged; piped to kubeseal stdin and discarded.
        value: z =>
          z.string({
            description:
              'The secret value (plaintext). Sealed immediately; never stored or logged.',
          }),
        // Target environments; each maps to the strict-scope namespace <team>-<env>.
        envs: z =>
          z
            .array(z.enum(['dev', 'prod']))
            .min(1)
            .describe('Target environments to seal for (dev and/or prod).'),
      },
      output: {
        pullRequestUrls: z =>
          z
            .array(z.string())
            .describe('The opened pull request URL(s), one per env.'),
      },
    },
    async handler(ctx) {
      // Implemented in M3-T4 (seal + PR) and M3-T5 (authorize + owner re-check).
      // Reference deps so the skeleton compiles cleanly and lints without unused warnings.
      void deps;
      void ctx;
      throw new Error(
        'capstone:seal-secret handler not yet implemented (M3-T4/T5).',
      );
    },
  });
}
