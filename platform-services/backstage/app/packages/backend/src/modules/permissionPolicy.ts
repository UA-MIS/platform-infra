/*
 * THE SPINE — the custom Backstage PermissionPolicy for "The Process" (M2).
 *
 * Delivers per-team visibility: a signed-in user sees catalog entities (Components, the
 * golden-path Template, etc.) ONLY when one of their GitHub teams owns them. The platform
 * admin team (`labmx`, D-027) sees everything. This single policy is the reusable hook
 * point that M3 (per-team secrets gate) and M4 (per-team scaffolder scoping) extend — so
 * it is structured as a clear if-ladder: admin override at top, the catalog ownership
 * filter in the middle, default-ALLOW at the bottom. Add new branches between them.
 *
 * How the ownership chain reaches this file (see plan §2 / §3.1):
 *   Dex login -> authOidcProcess resolves a REAL ingested catalog User (no fallback) ->
 *   that User's spec.memberOf (the GitHub teams from github-org ingestion) ->
 *   Backstage computes user.info.ownershipEntityRefs = [user ref + each team Group ref] ->
 *   isEntityOwner({ claims: ownershipEntityRefs }) filters entities by spec.owner.
 *
 * Why a CONDITIONAL decision (not a binary ALLOW/DENY) for catalog reads: a binary policy
 * sees the permission, not each entity, so it cannot FILTER a list — it would either show
 * all entities or none. createCatalogConditionalDecision returns a rule the catalog
 * evaluates per-entity, which makes list views, entity pages, and the catalog API all
 * honor ownership backend-side (the security-meaningful boundary, ADR-029 §6.2).
 *
 * Requires `permission.enabled: true` in app-config; without it the framework no-ops and
 * serves everything regardless of this policy (plan R6).
 */
import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  AuthorizeResult,
  PolicyDecision,
  isResourcePermission,
} from '@backstage/plugin-permission-common';
import {
  PermissionPolicy,
  PolicyQuery,
  PolicyQueryUser,
} from '@backstage/plugin-permission-node';
import { policyExtensionPoint } from '@backstage/plugin-permission-node/alpha';
import {
  catalogConditions,
  createCatalogConditionalDecision,
} from '@backstage/plugin-catalog-backend/alpha';
import { RESOURCE_TYPE_CATALOG_ENTITY } from '@backstage/plugin-catalog-common/alpha';

/**
 * The ingested GitHub team whose members are platform admins (D-027: `labmx` = admin).
 * Keyed on the github-org-ingested Group ref (single source of truth, no hand-seeded
 * group to drift). If the live admin team slug differs, change ONLY this constant.
 */
export const ADMIN_GROUP_REF = 'group:default/labmx';

export class CapstoneTeamPermissionPolicy implements PermissionPolicy {
  async handle(
    request: PolicyQuery,
    user?: PolicyQueryUser,
  ): Promise<PolicyDecision> {
    const ownershipRefs = user?.info.ownershipEntityRefs ?? [];

    // 1. ADMIN OVERRIDE — members of the platform admin team see + do everything.
    if (ownershipRefs.includes(ADMIN_GROUP_REF)) {
      return { result: AuthorizeResult.ALLOW };
    }

    // 2. CATALOG ENTITIES — conditional filter: the actor may read/act on an entity if
    //    EITHER (a) its spec.owner is one of their ownershipEntityRefs (owned Components/
    //    APIs/Systems/Templates — the per-team boundary, the spine), OR (b) it is a User or
    //    Group entity (the org graph). The org graph is non-sensitive (who's on which team)
    //    and a user MUST be able to read their OWN User/Group entities — otherwise, under
    //    permission.enabled, isEntityOwner alone DENIES them (a github-org User has no
    //    `ownedBy` relation, so `isEntityOwner` never matches it) → broken profile page /
    //    "my groups", and any code path that reads the user's own entity as the USER
    //    principal fails. The owned-boundary (a) still scopes the entities that actually
    //    matter (Components/APIs/templates per ADR-029 §6.2). With empty ownershipRefs this
    //    still resolves to "User/Group only" (NOT ALLOW-all) — the spine stays closed.
    if (isResourcePermission(request.permission, RESOURCE_TYPE_CATALOG_ENTITY)) {
      return createCatalogConditionalDecision(request.permission, {
        anyOf: [
          catalogConditions.isEntityOwner({ claims: ownershipRefs }),
          catalogConditions.isEntityKind({ kinds: ['User', 'Group'] }),
        ],
      });
    }

    // 3. SCAFFOLDER EXECUTE — left ALLOW in M2 (falls through to the default below). The
    //    shared "New Capstone Project" template is meant for ALL teams; M4's PR-gating is
    //    the real per-team control. Template READ is already filtered by (2). Revisit only
    //    if a team-private template appears.
    //
    // 4. M3 HOOK POINT — `capstone:seal-secret` will add a branch here that checks
    //    ownership of the target Component before sealing (reuses ownershipRefs +
    //    ADMIN_GROUP_REF). M2 leaves the structure ready; it does not implement that branch.

    // 5. DEFAULT — ALLOW everything not explicitly scoped above (search, techdocs,
    //    scaffolder execute, etc.). We do not lock down read-only platform features
    //    (ADR-029 §6.2); the boundary that matters is catalog visibility + (later) the
    //    secrets/scaffolder actions.
    return { result: AuthorizeResult.ALLOW };
  }
}

/**
 * Registers CapstoneTeamPermissionPolicy as the single permission policy. REPLACES the
 * stock allow-all policy module — only ONE policy can be set, so the allow-all import MUST
 * be removed from index.ts (plan R5) or the policies conflict.
 */
export const permissionPolicyModule = createBackendModule({
  pluginId: 'permission',
  moduleId: 'capstone-team-policy',
  register(reg) {
    reg.registerInit({
      deps: { policy: policyExtensionPoint },
      async init({ policy }) {
        policy.setPolicy(new CapstoneTeamPermissionPolicy());
      },
    });
  },
});

export default permissionPolicyModule;
