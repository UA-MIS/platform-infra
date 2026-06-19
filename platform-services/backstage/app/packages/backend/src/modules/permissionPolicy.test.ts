/*
 * Unit tests for THE SPINE — CapstoneTeamPermissionPolicy (M2, plan §5).
 *
 * These guard the three security-critical behaviors of per-team visibility:
 *  - admin (labmx) override -> unconditional ALLOW,
 *  - catalog-entity read for a non-admin -> a CONDITIONAL decision wrapping isEntityOwner
 *    with the user's ownershipEntityRefs (NOT a blanket ALLOW),
 *  - empty ownershipEntityRefs -> still CONDITIONAL with empty claims (owns nothing), NOT
 *    ALLOW-all (the silent-allow-all failure mode, plan R4),
 *  - a non-resource permission -> ALLOW (search/techdocs stay open).
 */
import {
  AuthorizeResult,
  ConditionalPolicyDecision,
  createPermission,
} from '@backstage/plugin-permission-common';
import { catalogEntityReadPermission } from '@backstage/plugin-catalog-common/alpha';
import { PolicyQuery, PolicyQueryUser } from '@backstage/plugin-permission-node';
import {
  ADMIN_GROUP_REF,
  CapstoneTeamPermissionPolicy,
} from './permissionPolicy';

// A minimal non-resource permission (search-like) — exercises the default-ALLOW branch.
const searchPermission = createPermission({
  name: 'search.query.read',
  attributes: { action: 'read' },
});

// Build a PolicyQueryUser carrying the given ownershipEntityRefs. Only the fields the
// policy reads are populated; credentials is a stub (the policy never touches it).
function userWith(ownershipEntityRefs: string[]): PolicyQueryUser {
  return {
    credentials: {} as PolicyQueryUser['credentials'],
    info: {
      userEntityRef: ownershipEntityRefs[0] ?? 'user:default/unknown',
      ownershipEntityRefs,
    },
  };
}

describe('CapstoneTeamPermissionPolicy', () => {
  const policy = new CapstoneTeamPermissionPolicy();

  it('grants unconditional ALLOW to admin-group (labmx) members', async () => {
    const request: PolicyQuery = { permission: catalogEntityReadPermission };
    const decision = await policy.handle(
      request,
      userWith(['user:default/alice', ADMIN_GROUP_REF]),
    );
    expect(decision.result).toBe(AuthorizeResult.ALLOW);
  });

  it('returns a CONDITIONAL isEntityOwner decision for a non-admin catalog read', async () => {
    const claims = ['user:default/bob', 'group:default/team-a'];
    const request: PolicyQuery = { permission: catalogEntityReadPermission };
    const decision = await policy.handle(request, userWith(claims));

    expect(decision.result).toBe(AuthorizeResult.CONDITIONAL);
    if (decision.result !== AuthorizeResult.CONDITIONAL) {
      throw new Error('expected a conditional decision');
    }
    // The conditional must scope to the CATALOG plugin and be the IS_ENTITY_OWNER rule
    // carrying the user's claims — i.e. the EXACT server-side filter the catalog applies
    // per-entity (this is what makes list views + the catalog API honor ownership, not a
    // blanket allow). Asserting the serialized rule shape proves the wiring is real.
    expect(decision.pluginId).toBe('catalog');
    expect(decision.conditions).toMatchObject({
      rule: 'IS_ENTITY_OWNER',
      resourceType: 'catalog-entity',
      params: { claims: ['user:default/bob', 'group:default/team-a'] },
    });
  });

  it('does NOT ALLOW-all when ownershipEntityRefs is empty (spine stays closed)', async () => {
    const request: PolicyQuery = { permission: catalogEntityReadPermission };
    const decision = await policy.handle(request, userWith([]));

    // The key guard (plan R4): empty ownership must still be a CONDITIONAL "owns nothing",
    // never AuthorizeResult.ALLOW.
    expect(decision.result).toBe(AuthorizeResult.CONDITIONAL);
    expect(decision.result).not.toBe(AuthorizeResult.ALLOW);
    // Empty claims array -> the IS_ENTITY_OWNER filter matches no entities (NOT allow-all).
    expect((decision as ConditionalPolicyDecision).conditions).toMatchObject({
      rule: 'IS_ENTITY_OWNER',
      params: { claims: [] },
    });
  });

  it('does NOT ALLOW-all when the user is undefined (no identity)', async () => {
    const request: PolicyQuery = { permission: catalogEntityReadPermission };
    const decision = await policy.handle(request, undefined);
    expect(decision.result).toBe(AuthorizeResult.CONDITIONAL);
    expect(decision.result).not.toBe(AuthorizeResult.ALLOW);
  });

  it('ALLOWs non-resource permissions (search/techdocs stay open)', async () => {
    const request: PolicyQuery = { permission: searchPermission };
    const decision = await policy.handle(
      request,
      userWith(['user:default/carol', 'group:default/team-b']),
    );
    expect(decision.result).toBe(AuthorizeResult.ALLOW);
  });
});
