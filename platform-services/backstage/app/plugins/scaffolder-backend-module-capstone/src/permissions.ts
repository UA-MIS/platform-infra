/*
 * The named permission the secrets capability is gated on (M3, plan §2.3).
 *
 * `capstone.secret.seal` is the single authorization point for sealing + publishing a
 * team secret. The DECISION for it lives in M2's CapstoneTeamPermissionPolicy (THE SPINE,
 * packages/backend/src/modules/permissionPolicy.ts) — owner-intersection with a `labmx`
 * admin override — so M3 does NOT add a parallel authz path (ADR-029 §6, plan §9). M3 only
 * (a) defines this permission and (b) authorizes the action handler against it; M2 owns the
 * rule that maps it to "the actor's GitHub teams own the target Component".
 *
 * It is a BASIC permission (not a resource permission): the per-entity owner check is done
 * by the policy against the actor's ownershipEntityRefs, and the handler re-derives + re-
 * checks the target owner itself as defense-in-depth (plan §2.3 / R1) so the action fails
 * closed even if the policy is misconfigured. attributes.action = 'create' (sealing writes
 * a new/rotated secret).
 */
import { createPermission } from '@backstage/plugin-permission-common';

/** Authorize sealing + publishing a team secret. Decided by M2's policy. */
export const sealSecretPermission = createPermission({
  name: 'capstone.secret.seal',
  attributes: { action: 'create' },
});

/**
 * Authorize TEARING DOWN a tenant — the destructive admin teardown page
 * (delete the CapstoneTenant XR claim → Crossplane cascade-prunes the whole tenant).
 *
 * Unlike `capstone.secret.seal` (owner-scoped: a team manages its OWN secrets), teardown is
 * ADMIN-ONLY. It removes another team's entire footprint (namespaces, Harbor project, Vault
 * paths, DB, ArgoCD apps), so it is NOT delegated to owning teams. The DECISION lives in the
 * same spine (packages/backend/src/modules/permissionPolicy.ts): admins (`labmx`, D-027)
 * ALLOW via the top-of-ladder override; everyone else is explicitly DENIED for this
 * permission (it must NOT fall through to the default-ALLOW tail). The handler
 * (teardownCore) re-derives the actor's admin membership as belt-and-suspenders (fail
 * closed) so it holds even if the policy is misconfigured. attributes.action = 'delete'.
 */
export const tenantTeardownPermission = createPermission({
  name: 'capstone.tenant.teardown',
  attributes: { action: 'delete' },
});

/** All capstone secrets permissions (exported for the permission registry / tests). */
export const capstoneSecretsPermissions = [sealSecretPermission];

/** All capstone tenant-admin permissions (exported for the permission registry / tests). */
export const capstoneTenantsPermissions = [tenantTeardownPermission];
