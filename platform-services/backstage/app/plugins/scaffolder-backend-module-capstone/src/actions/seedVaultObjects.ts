/*
 * capstone:seed-vault-app-objects — create the per-env `app` Vault object EMPTY at onboarding.
 *
 * ── THE PROBLEM THIS SOLVES ───────────────────────────────────────────────────────────────
 * Vault KV-v2 creates an object on first write, so `tenants/<team>/<env>/app` does not exist
 * until somebody sets their first secret. Nothing in provisioning creates it (the `database`
 * and `harbor-pull` objects ARE provisioned, which is why those sync while `app` does not —
 * that asymmetry is the signature of this bug, verified across the fleet: mychef/dev EXISTS
 * while mychef staging+prod and all three motion envs return 404).
 *
 * An absent object makes ESO report:
 *   - under deletionPolicy Delete  -> Ready=TRUE / SecretDeleted, no Secret, ArgoCD green.
 *     Byte-identical to an environment whose secrets were DESTROYED. That ambiguity is the
 *     real defect: "never configured" and "catastrophically lost" are the same signal.
 *   - under deletionPolicy Retain  -> Ready=FALSE, which pages. Correct for a real loss, but
 *     every freshly scaffolded tenant would alert on day one for doing nothing wrong — two
 *     alerts per tenant (staging + prod), and a 60-tenant class means ~120 false pages.
 *
 * Seeding an EMPTY object separates the two. An empty object is healthy and produces no
 * Secret — verified against ESO v2.6.0: Ready=True / SecretSynced, message "secret retained
 * due to DeletionPolicy=Retain", secret NotFound. So "never configured" is quiet and only a
 * genuinely destroyed object is loud.
 *
 * ── WHY THIS IS AN ACTION AND NOT A CROSSPLANE MANAGED RESOURCE ───────────────────────────
 * The architecturally "pure" option is a provider-vault SecretV2 in the Composition, since
 * onboarding is otherwise declarative. It was rejected on blast radius. A managed resource
 * CONTINUOUSLY RECONCILES: the moment its managementPolicies are wrong, absent, or reset by a
 * future edit, Crossplane drives `tenants/<team>/<env>/app` back to its declared `{}` — wiping
 * every secret every team has ever set, on every tenant, forever, and reporting healthy while
 * it does it. Its safety would rest on a config field staying correct in perpetuity.
 *
 * This action instead relies on `VaultClient.ensureObject`, which writes with `cas: 0` —
 * Vault's "only if this key does not exist". The request is PHYSICALLY INCAPABLE of
 * overwriting, no matter how often it runs or against which path. Given the failure mode
 * being prevented is a silent one, a safety property enforced by Vault beats one enforced by
 * a YAML field.
 *
 * ── BEST-EFFORT ON PURPOSE ────────────────────────────────────────────────────────────────
 * A failure here does NOT fail the scaffold. An unseeded tenant is exactly the status quo —
 * the object appears on first write — so aborting onboarding over it would trade a small,
 * recoverable annoyance for a large one.
 */
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import { InputError } from '@backstage/errors';
import { LoggerService, RootConfigService } from '@backstage/backend-plugin-api';
import { VaultClient } from '../vaultClient';
import { readVaultConfig } from '../sealCore';

/** The environments a scaffolded tenant gets. Mirrors the overlays the templates ship. */
const DEFAULT_ENVS = ['dev', 'staging', 'prod', 'preview'];

/** Same slug rule the XRD enforces; also guarantees the Vault path cannot escape tenants/. */
const TEAM_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

export type SeedVaultObjectsActionDeps = {
  config: RootConfigService;
  logger: LoggerService;
};

export function createSeedVaultObjectsAction(deps: SeedVaultObjectsActionDeps) {
  return createTemplateAction({
    id: 'capstone:seed-vault-app-objects',
    description:
      "Create the team's per-environment app secret objects in Vault, EMPTY, so an " +
      'environment nobody has configured yet is distinguishable from one whose secrets were ' +
      'destroyed. Never writes or overwrites a value (cas:0 create-if-absent).',
    schema: {
      input: {
        team: z =>
          z.string({ description: 'The team slug (e.g. team-alpha).' }),
        envs: z =>
          z
            .array(z.string(), {
              description: `Environments to seed. Defaults to ${DEFAULT_ENVS.join(', ')}.`,
            })
            .optional(),
      },
    },
    async handler(ctx) {
      const { team, envs } = ctx.input as { team: string; envs?: string[] };
      if (typeof team !== 'string' || !TEAM_RE.test(team)) {
        throw new InputError(
          `Invalid team slug "${team}". A team slug is lowercase alphanumeric with internal ` +
            `dashes (e.g. team-alpha) — this is also what keeps the Vault path inside ` +
            `tenants/, so it is enforced rather than sanitized.`,
        );
      }
      const targets = envs?.length ? envs : DEFAULT_ENVS;

      const vault = new VaultClient(readVaultConfig(deps.config));
      for (const env of targets) {
        const path = `tenants/${team}/${env}/app`;
        try {
          await vault.ensureObject(path);
        } catch (e) {
          // Best-effort: an unseeded object is the status quo, and the tenant still works.
          deps.logger.warn(
            `capstone: could not seed the Vault app object at ${path} ` +
              `(${(e as Error).message}). Onboarding continues; the object will be created on ` +
              `the first secret write. The only consequence is that this environment is not yet ` +
              `distinguishable from one whose secrets were lost.`,
          );
        }
      }
    },
  });
}
