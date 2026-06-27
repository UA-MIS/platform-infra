/*
 * capstone:harbor-onboard — create the team's Harbor PROJECT (+ OIDC Developer mapping)
 * at SCAFFOLD time, so a fresh team's very first CI build can push.
 *
 * WHY THIS ACTION EXISTS:
 * The tenant CI (.github/workflows/build-and-push.yaml) pushes the built image to
 * `harbor.<domain>/<team>/<app>:<tag>` (registry = the team's Harbor project, keyed on
 * the canonical <team> slug, D-026). The Kaniko push cred (`harbor-push`) is injected by
 * the platform ARC container-hook — but NOTHING created the Harbor PROJECT itself. The
 * onboarding PR's checklist lists `make harbor-onboard` as a MANUAL post-merge operator
 * step; if it isn't run, the first build fails with
 *   UNAUTHORIZED: project <team> not found
 * (Harbor reports a push to a missing project as not-found/unauthorized). This action
 * closes that gap by creating the project as part of the scaffold run, BEFORE the repo's
 * first build can fire.
 *
 * SCOPE (team-lead decision A, v1 = single team):
 *   - create the private, auto-scan project named <team>  (idempotent: 409 -> OK)
 *   - map the OIDC group `UA-MIS:<team>` -> Developer (role_id 2)  (idempotent: 409 -> OK)
 * It does NOT mint robots. The CI PUSH robot + per-env PULL robots stay in the operator's
 * post-merge `make harbor-*-robot` steps (the robot token is Harbor-generated, one-time,
 * and must be sealed into the cluster — out of scope for a web-facing scaffolder backend).
 * The shared-`harbor-push` last-write-wins multi-tenant collision is a SEPARATE post-v1
 * follow-up — see the onboarding PR checklist + the PR description for this action.
 *
 * AUTH (team-lead decision B): this action authenticates to Harbor with a DEDICATED,
 * least-privilege PROVISIONER ROBOT (system-level, project-create + member-add only) —
 * NOT the full `harbor-admin` account. Admin in a web-facing backend is too much blast
 * radius. The robot's username/secret come from backend config (capstone.harbor.*), which
 * the deploy materializes into the backstage namespace (NOT committed). See config.d.ts.
 *
 * The HTTP Basic credential is sent only in the Authorization header and is NEVER logged
 * (only the project/group names and HTTP status codes are logged).
 */
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import type { Config } from '@backstage/config';
import type {
  AuthService,
  BackstageCredentials,
  LoggerService,
} from '@backstage/backend-plugin-api';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import { NotAllowedError } from '@backstage/errors';

/**
 * The platform-staff admin group; a member of it may onboard ANY team (the same
 * `labmx` override sealCore uses for the secrets owner re-check). Keep this in sync
 * with sealCore.ADMIN_GROUP_REF.
 */
export const ADMIN_GROUP_REF = 'group:default/labmx';

/**
 * A Harbor project name (= the canonical team slug, D-026) must be a DNS-ish label:
 * lowercase alphanumerics + hyphens, not starting/ending with a hyphen. This mirrors
 * the Scaffolder template's `team` parameter `pattern`. We re-validate here so the
 * action is safe even if invoked outside that template — a bad slug must never reach a
 * Harbor API path or a request body.
 */
const SLUG = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;

/** Minimal fetch surface so tests can inject a mock without DOM lib types. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{ status: number; text: () => Promise<string> }>;

/** Resolved, validated Harbor connection config for the provisioner. */
export interface HarborConfig {
  /** Harbor core base URL, no trailing slash (e.g. http://harbor-core.harbor.svc:80). */
  baseUrl: string;
  /** Provisioner robot username (e.g. `robot$capstone-provisioner`). */
  username: string;
  /** Provisioner robot secret. */
  secret: string;
  /** OIDC group-name prefix; the mapped group is `<oidcGroupPrefix>:<team>`. */
  oidcGroupPrefix: string;
}

/**
 * Read + validate `capstone.harbor.*` from backend config. The base URL defaults to the
 * in-cluster Harbor core service; username/secret are REQUIRED (no insecure default — the
 * action must fail closed, not silently run unauthenticated). Throws a clear error naming
 * the missing key so a misconfigured deploy is obvious at first scaffold.
 */
export function readHarborConfig(config: Config): HarborConfig {
  const c = config.getOptionalConfig('capstone.harbor');
  if (!c) {
    throw new Error(
      'capstone:harbor-onboard: missing config section `capstone.harbor` ' +
        '(need baseUrl + provisioner username/secret).',
    );
  }
  const baseUrl = (
    c.getOptionalString('baseUrl') ?? 'http://harbor-core.harbor.svc:80'
  ).replace(/\/+$/, '');
  const username = c.getOptionalString('username');
  const secret = c.getOptionalString('secret');
  if (!username || !secret) {
    throw new Error(
      'capstone:harbor-onboard: `capstone.harbor.username` and ' +
        '`capstone.harbor.secret` are required (the dedicated least-privilege ' +
        'provisioner robot). Refusing to call Harbor unauthenticated.',
    );
  }
  const oidcGroupPrefix = c.getOptionalString('oidcGroupPrefix') ?? 'UA-MIS';
  return { baseUrl, username, secret, oidcGroupPrefix };
}

/** Build the HTTP Basic Authorization header value for the provisioner robot. */
function basicAuth(username: string, secret: string): string {
  return `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}`;
}

/**
 * Idempotently ensure the Harbor project + OIDC Developer mapping exist. Pure (takes its
 * fetch + config + logger) so it's unit-testable without a live Harbor. Returns whether
 * each resource was newly created (201) vs already present (409) for the action output.
 *
 * Idempotency contract: Harbor returns 201 on create and 409 when the project/member
 * already exists; BOTH are success here (re-scaffolding or a re-run is safe). Any other
 * status fails loud with the response body so a real misconfig (401/403 bad robot, 5xx)
 * is never swallowed.
 */
export async function ensureHarborProject(args: {
  fetchImpl: FetchLike;
  cfg: HarborConfig;
  team: string;
  logger: LoggerService;
}): Promise<{ projectCreated: boolean; groupMapped: boolean }> {
  const { fetchImpl, cfg, team, logger } = args;

  if (!SLUG.test(team)) {
    throw new Error(
      `capstone:harbor-onboard: invalid team slug '${team}' — must be a DNS label ` +
        `matching ${SLUG}.`,
    );
  }

  const auth = basicAuth(cfg.username, cfg.secret);
  const headers = {
    Authorization: auth,
    'Content-Type': 'application/json',
  };

  // --- 1) create the private, auto-scan project named <team> ------------------
  logger.info(`capstone:harbor-onboard: ensuring project '${team}' (private, auto_scan)`);
  const projRes = await fetchImpl(`${cfg.baseUrl}/api/v2.0/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      project_name: team,
      metadata: { public: 'false', auto_scan: 'true' },
    }),
  });
  let projectCreated: boolean;
  switch (projRes.status) {
    case 201:
      projectCreated = true;
      logger.info(`capstone:harbor-onboard: project '${team}' created.`);
      break;
    case 409:
      projectCreated = false;
      logger.info(`capstone:harbor-onboard: project '${team}' already exists (idempotent OK).`);
      break;
    default:
      throw new Error(
        `capstone:harbor-onboard: create project '${team}' failed: HTTP ` +
          `${projRes.status} — ${await projRes.text()}`,
      );
  }

  // --- 2) map the OIDC group <prefix>:<team> -> Developer (role_id 2) ----------
  // group_type 3 = OIDC group; role_id 2 = Developer (push/pull). Mirrors the
  // ArgoCD role:<team> scoping — one <team> slug everywhere (D-026/D-027).
  const groupName = `${cfg.oidcGroupPrefix}:${team}`;
  logger.info(
    `capstone:harbor-onboard: mapping OIDC group '${groupName}' -> Developer on '${team}'`,
  );
  const memRes = await fetchImpl(
    `${cfg.baseUrl}/api/v2.0/projects/${encodeURIComponent(team)}/members`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        role_id: 2,
        member_group: { group_name: groupName, group_type: 3 },
      }),
    },
  );
  let groupMapped: boolean;
  switch (memRes.status) {
    case 201:
      groupMapped = true;
      logger.info(`capstone:harbor-onboard: group mapping created.`);
      break;
    case 409:
      groupMapped = false;
      logger.info(`capstone:harbor-onboard: group mapping already present (idempotent OK).`);
      break;
    default:
      throw new Error(
        `capstone:harbor-onboard: map group '${groupName}' failed: HTTP ` +
          `${memRes.status} — ${await memRes.text()}`,
      );
  }

  return { projectCreated, groupMapped };
}

/** Extract the actor's user entity ref from credentials; throws if not an authenticated user. */
function requireUserRef(credentials: BackstageCredentials): string {
  const userRef = (credentials.principal as { userEntityRef?: string } | undefined)
    ?.userEntityRef;
  if (!userRef) {
    throw new NotAllowedError(
      'capstone:harbor-onboard requires an authenticated user identity ' +
        '(no service-to-service onboarding).',
    );
  }
  return userRef;
}

/**
 * Derive the actor's ownership refs (their User ref + each team Group ref). Uses the
 * catalog to resolve the user's group memberships — mirrors how M2's policy obtains
 * ownershipEntityRefs and how sealCore.resolveActorOwnership does the secrets owner
 * re-check, so this access-control check matches the platform's authz model.
 */
async function resolveActorOwnership(
  catalog: CatalogService,
  serviceCreds: Awaited<ReturnType<AuthService['getOwnServiceCredentials']>>,
  userEntityRef: string,
): Promise<string[]> {
  const refs = new Set<string>([userEntityRef]);
  const { items } = await catalog.getEntities(
    {
      filter: [
        { kind: 'Group', 'relations.hasMember': userEntityRef },
        { kind: 'Group', 'spec.members': parseEntityRef(userEntityRef).name },
      ],
      fields: ['kind', 'metadata.name', 'metadata.namespace'],
    },
    { credentials: serviceCreds },
  );
  for (const g of items) {
    refs.add(stringifyEntityRef(g));
  }
  return Array.from(refs);
}

/**
 * Access control (SEC-020): the initiator must OWN the team they are onboarding — i.e. be
 * a member of `group:default/<team>` — or be a platform-staff admin (`labmx`). Without
 * this, any signed-in user could pass `team: team-rival` and create another team's Harbor
 * project + grant `UA-MIS:team-rival` Developer. Fails CLOSED (throws) on any miss, and is
 * called BEFORE any Harbor API call so a denial makes ZERO Harbor requests.
 *
 * Mirrors sealCore's belt-and-suspenders owner re-check (labmx short-circuit). The check is
 * membership of the team Group directly (this action's input is a team slug, not a Component
 * entityRef), which is the same group the platform keys per-team RBAC/registry on (D-026).
 */
export async function authorizeTeamOwnership(args: {
  catalog: CatalogService;
  auth: AuthService;
  credentials: BackstageCredentials;
  team: string;
}): Promise<void> {
  const { catalog, auth, credentials, team } = args;
  const actorUserRef = requireUserRef(credentials);
  const serviceCreds = await auth.getOwnServiceCredentials();
  const actorOwnership = await resolveActorOwnership(
    catalog,
    serviceCreds,
    actorUserRef,
  );
  const teamGroupRef = stringifyEntityRef({
    kind: 'Group',
    namespace: 'default',
    name: team,
  });
  const isAdmin = actorOwnership.includes(ADMIN_GROUP_REF);
  const ownsTeam = actorOwnership.includes(teamGroupRef);
  if (!isAdmin && !ownsTeam) {
    throw new NotAllowedError(
      `You are not a member of team '${team}'; Harbor onboarding is restricted to the ` +
        `owning team (or platform staff).`,
    );
  }
}

/** Services the action handler needs, injected from the module's registerInit. */
export interface HarborOnboardActionDeps {
  config: Config;
  catalog: CatalogService;
  auth: AuthService;
  /**
   * Injectable fetch — defaults to the global fetch (Node 18+/24 in the backstage image).
   * Tests pass a mock to assert request shape + idempotency without a live Harbor.
   */
  fetchImpl?: FetchLike;
}

/**
 * Factory for the `capstone:harbor-onboard` action. Takes its deps so the module wires
 * config in at registration (createBackendModule registerInit), keeping the action
 * unit-testable with a mock fetch + mock config.
 */
export function createHarborOnboardAction(deps: HarborOnboardActionDeps) {
  const { config, catalog, auth } = deps;
  const fetchImpl: FetchLike =
    deps.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);

  return createTemplateAction({
    id: 'capstone:harbor-onboard',
    description:
      "Create the team's Harbor project (private, auto-scan) and map its OIDC group " +
      '-> Developer, at scaffold time, so the first CI build can push. Idempotent ' +
      '(already-exists is success). Authenticates with the dedicated least-privilege ' +
      'Harbor provisioner robot from backend config (capstone.harbor.*).',
    schema: {
      input: {
        team: z =>
          z.string({
            description:
              'Team slug (DNS label) — the canonical D-026 slug that names the Harbor ' +
              'project and the OIDC group suffix (group = <prefix>:<team>).',
          }),
      },
      output: {
        project: z =>
          z.string({ description: 'The Harbor project name (= team slug).' }),
        projectCreated: z =>
          z.boolean({
            description: 'true if the project was newly created, false if it already existed.',
          }),
        groupMapped: z =>
          z.boolean({
            description:
              'true if the OIDC group->Developer mapping was newly created, false if present.',
          }),
      },
    },

    async handler(ctx) {
      const { team } = ctx.input;

      // ACCESS CONTROL (SEC-020) — FIRST, before reading config or touching Harbor: the
      // initiator must own `team` (member of group:default/<team>) or be labmx admin.
      // Fails closed; a denial makes ZERO Harbor calls.
      const credentials = await ctx.getInitiatorCredentials();
      await authorizeTeamOwnership({ catalog, auth, credentials, team });

      const cfg = readHarborConfig(config);

      const { projectCreated, groupMapped } = await ensureHarborProject({
        fetchImpl,
        cfg,
        team,
        logger: ctx.logger,
      });

      ctx.output('project', team);
      ctx.output('projectCreated', projectCreated);
      ctx.output('groupMapped', groupMapped);
    },
  });
}
