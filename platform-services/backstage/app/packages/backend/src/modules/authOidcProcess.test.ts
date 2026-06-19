/*
 * Unit tests for the M2 sign-in resolver tightening (plan §3.1 / §5).
 *
 * The resolver is the linchpin: it MUST resolve strictly to a real ingested catalog User
 * (no dangerousEntityRefFallback) so ownershipEntityRefs carry the user's team groups. The
 * resolver runs the lookup in EXPLICIT steps (findCatalogUser -> resolveOwnershipEntityRefs
 * -> issueToken) with a RETRY around the catalog loopback call (which has been observed to
 * intermittently drop with "Premature close"), and logs failures (the sign-in frame handler
 * otherwise swallows the throw into a client-side message — "200 contentLength 0" in the
 * pod). We assert:
 *  (1) preferred_username is matched, lowercased, and resolved by entityRef name;
 *  (2) the issued token carries sub = the resolved entity ref and ent = ownershipEntityRefs
 *      (identical to signInWithCatalogUser's success path, NO fallback);
 *  (3) a TRANSIENT lookup drop is retried and sign-in succeeds on a later attempt;
 *  (4) a persistent transient failure exhausts retries and throws a clear error;
 *  (5) a genuinely-missing User is NOT retried and throws a clear "no catalog User" error;
 *  (6) a profile with no usable claim throws before any catalog call.
 */
import {
  AuthResolverContext,
  OAuthAuthenticatorResult,
  SignInInfo,
} from '@backstage/plugin-auth-node';
import { OidcAuthResult } from '@backstage/plugin-auth-backend-module-oidc-provider';
import { Entity } from '@backstage/catalog-model';
import { NotFoundError } from '@backstage/errors';
import { processOidcSignInResolver } from './authOidcProcess';

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

describe('processOidcSignInResolver', () => {
  let findCatalogUser: jest.Mock;
  let resolveOwnershipEntityRefs: jest.Mock;
  let issueToken: jest.Mock;
  let ctx: AuthResolverContext;

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
  });

  it('resolves preferred_username by entityRef name (no annotations/filter, no fallback)', async () => {
    await processOidcSignInResolver(
      infoWith({ preferred_username: 'octocat' }),
      ctx,
    );

    expect(findCatalogUser).toHaveBeenCalledTimes(1);
    expect(findCatalogUser).toHaveBeenCalledWith({
      entityRef: { name: 'octocat' },
    });
  });

  it('issues a token with sub = resolved entity ref and ent = ownershipEntityRefs', async () => {
    await processOidcSignInResolver(
      infoWith({ preferred_username: 'octocat' }),
      ctx,
    );

    expect(issueToken).toHaveBeenCalledTimes(1);
    expect(issueToken).toHaveBeenCalledWith({
      claims: {
        sub: 'user:default/octocat',
        ent: ['user:default/octocat', 'group:default/team-a'],
      },
    });
  });

  it('lowercases the GitHub login before matching (case gotcha, R2)', async () => {
    await processOidcSignInResolver(
      infoWith({ preferred_username: 'OctoCat' }),
      ctx,
    );
    expect(findCatalogUser).toHaveBeenCalledWith({
      entityRef: { name: 'octocat' },
    });
  });

  it('retries a transient "Premature close" drop and succeeds on the next attempt', async () => {
    // First attempt drops mid-response; second attempt succeeds.
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

    const result = await processOidcSignInResolver(
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
      processOidcSignInResolver(infoWith({ preferred_username: 'octocat' }), ctx),
    ).rejects.toThrow(/could not resolve catalog User for "octocat" after 3 attempt/);
    // Retried up to the max (3) attempts.
    expect(findCatalogUser).toHaveBeenCalledTimes(3);
    expect(issueToken).not.toHaveBeenCalled();
  });

  it('does NOT retry a genuine NotFound and throws a clear non-member error', async () => {
    findCatalogUser.mockRejectedValue(new NotFoundError('User not found'));

    await expect(
      processOidcSignInResolver(
        infoWith({ preferred_username: 'not-on-any-team' }),
        ctx,
      ),
    ).rejects.toThrow(
      /no catalog User matches GitHub login "not-on-any-team"/,
    );
    // NotFound is not retryable -> exactly one attempt.
    expect(findCatalogUser).toHaveBeenCalledTimes(1);
    expect(issueToken).not.toHaveBeenCalled();
  });

  it('throws when the profile carries no usable login claim', async () => {
    await expect(
      processOidcSignInResolver(infoWith({}), ctx),
    ).rejects.toThrow(/missing preferred_username/);
    expect(findCatalogUser).not.toHaveBeenCalled();
  });
});
