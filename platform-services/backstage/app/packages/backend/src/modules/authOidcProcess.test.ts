/*
 * Unit tests for the M2 sign-in resolver (plan §3.1 / §5).
 *
 * The resolver is the linchpin: it resolves strictly to a real ingested catalog User (no
 * dangerousEntityRefFallback), RETRIES the catalog loopback call (intermittent "Premature
 * close"), AUGMENTS ownership from Group.spec.members (F1, robust to relation-stitching
 * lag), and logs failures (the sign-in frame handler otherwise swallows the throw into a
 * client-side message — "200 contentLength 0" in the pod). We assert:
 *  (1) preferred_username is matched, lowercased, resolved by entityRef name;
 *  (2) the issued token carries sub = resolved entity ref and ent = union(standard refs,
 *      F1 group refs), de-duped;
 *  (3) a TRANSIENT lookup drop is retried and sign-in succeeds on a later attempt;
 *  (4) a persistent transient failure exhausts retries and throws a clear error;
 *  (5) a genuinely-missing User is NOT retried and throws a clear non-member error;
 *  (6) F1 augments admin recognition: a Group listing the user in spec.members is unioned
 *      into ent even when the standard refs lack it (the relations-lag case);
 *  (7) F1 is guarded: a failing group lookup degrades to the standard refs (no throw);
 *  (8) a profile with no usable claim throws before any catalog call.
 */
import {
  AuthResolverContext,
  OAuthAuthenticatorResult,
  SignInInfo,
} from '@backstage/plugin-auth-node';
import { OidcAuthResult } from '@backstage/plugin-auth-backend-module-oidc-provider';
import { Entity } from '@backstage/catalog-model';
import { NotFoundError } from '@backstage/errors';
import type { AuthService } from '@backstage/backend-plugin-api';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { createProcessOidcSignInResolver } from './authOidcProcess';

// Build a minimal SignInInfo whose fullProfile.userinfo carries the given claims.
function infoWith(userinfo: Record<string, unknown>) {
  return {
    profile: {},
    result: {
      fullProfile: { userinfo },
    },
  } as unknown as SignInInfo<OAuthAuthenticatorResult<OidcAuthResult>>;
}

function userEntity(name: string): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'User',
    metadata: { name, namespace: 'default' },
    spec: {},
  };
}

function groupEntity(name: string): Entity {
  return {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Group',
    metadata: { name, namespace: 'default' },
    spec: { type: 'team', children: [] },
  };
}

describe('createProcessOidcSignInResolver', () => {
  let findCatalogUser: jest.Mock;
  let resolveOwnershipEntityRefs: jest.Mock;
  let issueToken: jest.Mock;
  let ctx: AuthResolverContext;
  let getEntities: jest.Mock;
  let catalog: CatalogService;
  let auth: AuthService;
  let resolver: ReturnType<typeof createProcessOidcSignInResolver>;

  beforeEach(() => {
    findCatalogUser = jest
      .fn()
      .mockImplementation(async (q: { entityRef: { name: string } }) => ({
        entity: userEntity(q.entityRef.name),
      }));
    resolveOwnershipEntityRefs = jest.fn().mockResolvedValue({
      ownershipEntityRefs: ['user:default/octocat', 'group:default/team-a'],
    });
    issueToken = jest.fn().mockResolvedValue({ token: 'signed-in-token' });
    ctx = {
      findCatalogUser,
      resolveOwnershipEntityRefs,
      issueToken,
    } as unknown as AuthResolverContext;

    // F1 group lookup returns no extra groups by default (most tests don't exercise lag).
    getEntities = jest.fn().mockResolvedValue({ items: [] });
    catalog = { getEntities } as unknown as CatalogService;
    auth = {
      getOwnServiceCredentials: jest.fn().mockResolvedValue({}),
    } as unknown as AuthService;

    resolver = createProcessOidcSignInResolver({ catalog, auth });
  });

  it('resolves preferred_username by entityRef name (no annotations/filter, no fallback)', async () => {
    await resolver(infoWith({ preferred_username: 'octocat' }), ctx);

    expect(findCatalogUser).toHaveBeenCalledTimes(1);
    expect(findCatalogUser).toHaveBeenCalledWith({
      entityRef: { name: 'octocat' },
    });
  });

  it('issues a token with sub = resolved entity ref and ent = standard ownership refs', async () => {
    await resolver(infoWith({ preferred_username: 'octocat' }), ctx);

    expect(issueToken).toHaveBeenCalledTimes(1);
    expect(issueToken).toHaveBeenCalledWith({
      claims: {
        sub: 'user:default/octocat',
        ent: ['user:default/octocat', 'group:default/team-a'],
      },
    });
  });

  it('lowercases the GitHub login before matching (case gotcha, R2)', async () => {
    await resolver(infoWith({ preferred_username: 'OctoCat' }), ctx);
    expect(findCatalogUser).toHaveBeenCalledWith({
      entityRef: { name: 'octocat' },
    });
  });

  it('retries a transient "Premature close" drop and succeeds on the next attempt', async () => {
    findCatalogUser
      .mockRejectedValueOnce(
        new Error(
          'Invalid response body while trying to fetch ' +
            'http://localhost:7007/api/catalog/entities/by-name/User/default/octocat: ' +
            'Premature close',
        ),
      )
      .mockImplementationOnce(async (q: { entityRef: { name: string } }) => ({
        entity: userEntity(q.entityRef.name),
      }));

    const result = await resolver(
      infoWith({ preferred_username: 'octocat' }),
      ctx,
    );

    expect(result).toEqual({ token: 'signed-in-token' });
    expect(findCatalogUser).toHaveBeenCalledTimes(2);
    expect(issueToken).toHaveBeenCalledTimes(1);
  });

  it('exhausts retries on a persistent transient failure and throws a clear error', async () => {
    findCatalogUser.mockRejectedValue(new Error('socket hang up'));

    await expect(
      resolver(infoWith({ preferred_username: 'octocat' }), ctx),
    ).rejects.toThrow(/could not resolve catalog User for "octocat" after 5 attempt/);
    expect(findCatalogUser).toHaveBeenCalledTimes(5);
    expect(issueToken).not.toHaveBeenCalled();
    // 5 attempts = 4 real backoffs (250+500+1000+2000 ≈ 3.75s); allow headroom over the 5s default.
  }, 10000);

  it('does NOT retry a genuine NotFound and throws a clear non-member error', async () => {
    findCatalogUser.mockRejectedValue(new NotFoundError('User not found'));

    await expect(
      resolver(infoWith({ preferred_username: 'not-on-any-team' }), ctx),
    ).rejects.toThrow(
      /no catalog User matches GitHub login "not-on-any-team"/,
    );
    expect(findCatalogUser).toHaveBeenCalledTimes(1);
    expect(issueToken).not.toHaveBeenCalled();
  });

  it('F1: unions Group.spec.members groups into ent even when standard refs lack them (relations-lag)', async () => {
    // Standard ownership resolution lags: only the self ref, NO labmx admin group.
    resolveOwnershipEntityRefs.mockResolvedValue({
      ownershipEntityRefs: ['user:default/ccsmith33'],
    });
    // F1 group lookup finds the admin group via spec.members.
    getEntities.mockResolvedValue({ items: [groupEntity('labmx')] });

    await resolver(infoWith({ preferred_username: 'ccsmith33' }), ctx);

    expect(getEntities).toHaveBeenCalledTimes(1);
    expect(issueToken).toHaveBeenCalledWith({
      claims: {
        sub: 'user:default/ccsmith33',
        // labmx unioned in -> admin override will now fire in the policy.
        ent: ['user:default/ccsmith33', 'group:default/labmx'],
      },
    });
  });

  it('F1: de-dupes when the group is already present in the standard refs', async () => {
    resolveOwnershipEntityRefs.mockResolvedValue({
      ownershipEntityRefs: ['user:default/ccsmith33', 'group:default/labmx'],
    });
    getEntities.mockResolvedValue({ items: [groupEntity('labmx')] });

    await resolver(infoWith({ preferred_username: 'ccsmith33' }), ctx);

    expect(issueToken).toHaveBeenCalledWith({
      claims: {
        sub: 'user:default/ccsmith33',
        ent: ['user:default/ccsmith33', 'group:default/labmx'],
      },
    });
  });

  it('F1 is guarded: a failing group lookup degrades to the standard refs (no throw)', async () => {
    getEntities.mockRejectedValue(new Error('catalog unavailable'));

    const result = await resolver(
      infoWith({ preferred_username: 'octocat' }),
      ctx,
    );

    expect(result).toEqual({ token: 'signed-in-token' });
    expect(issueToken).toHaveBeenCalledWith({
      claims: {
        sub: 'user:default/octocat',
        ent: ['user:default/octocat', 'group:default/team-a'],
      },
    });
  });

  it('throws when the profile carries no usable login claim', async () => {
    await expect(resolver(infoWith({}), ctx)).rejects.toThrow(
      /missing preferred_username/,
    );
    expect(findCatalogUser).not.toHaveBeenCalled();
  });
});
