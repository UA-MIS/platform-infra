/*
 * Unit tests for the M2 sign-in resolver tightening (plan §3.1 / §5).
 *
 * The resolver is the linchpin: it MUST resolve strictly to a real ingested catalog User
 * (no dangerousEntityRefFallback) so ownershipEntityRefs carry the user's team groups. The
 * resolver runs the lookup in EXPLICIT steps (findCatalogUser -> resolveOwnershipEntityRefs
 * -> issueToken) so failures are logged (the sign-in frame handler otherwise swallows the
 * throw into a client-side message — "200 contentLength 0" in the pod). We assert:
 *  (1) preferred_username is matched, lowercased, and resolved by entityRef name;
 *  (2) the issued token carries sub = the resolved entity ref and ent = ownershipEntityRefs
 *      (identical to signInWithCatalogUser's success path, NO fallback);
 *  (3) a missing User propagates (sign-in fails) rather than minting a synthetic identity;
 *  (4) a profile with no usable claim throws before any catalog call.
 */
import {
  AuthResolverContext,
  OAuthAuthenticatorResult,
  SignInInfo,
} from '@backstage/plugin-auth-node';
import { OidcAuthResult } from '@backstage/plugin-auth-backend-module-oidc-provider';
import { Entity } from '@backstage/catalog-model';
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

  it('propagates the failure when no ingested User matches (no synthetic identity)', async () => {
    findCatalogUser.mockRejectedValueOnce(new Error('User not found'));
    await expect(
      processOidcSignInResolver(
        infoWith({ preferred_username: 'not-on-any-team' }),
        ctx,
      ),
    ).rejects.toThrow('User not found');
    expect(issueToken).not.toHaveBeenCalled();
  });

  it('throws when the profile carries no usable login claim', async () => {
    await expect(
      processOidcSignInResolver(infoWith({}), ctx),
    ).rejects.toThrow(/missing preferred_username/);
    expect(findCatalogUser).not.toHaveBeenCalled();
  });
});
