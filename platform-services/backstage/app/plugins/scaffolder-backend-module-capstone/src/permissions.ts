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

/** All capstone secrets permissions (exported for the permission registry / tests). */
export const capstoneSecretsPermissions = [sealSecretPermission];
