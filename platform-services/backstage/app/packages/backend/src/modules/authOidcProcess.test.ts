/*
 * Unit tests for the M2 sign-in resolver tightening (plan §3.1 / §5).
 *
 * The resolver is the linchpin: it MUST resolve strictly to a real ingested catalog User
 * (no dangerousEntityRefFallback) so ownershipEntityRefs carry the user's team groups. We
 * assert: (1) preferred_username is matched, lowercased; (2) no fallback option is passed
 * to signInWithCatalogUser; (3) a missing User propagates (sign-in fails) rather than
 * minting a synthetic identity; (4) a profile with no usable claim throws.
 */
import {
  AuthResolverContext,
  OAuthAuthenticatorResult,
  SignInInfo,
} from '@backstage/plugin-auth-node';
import { OidcAuthResult } from '@backstage/plugin-auth-backend-module-oidc-provider';
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

describe('processOidcSignInResolver', () => {
  let signInWithCatalogUser: jest.Mock;
  let ctx: AuthResolverContext;

  beforeEach(() => {
    signInWithCatalogUser = jest
      .fn()
      .mockResolvedValue({ token: 'signed-in-token' });
    ctx = { signInWithCatalogUser } as unknown as AuthResolverContext;
  });

  it('resolves preferred_username to a catalog User WITHOUT a dangerous fallback', async () => {
    await processOidcSignInResolver(
      infoWith({ preferred_username: 'octocat' }),
      ctx,
    );

    expect(signInWithCatalogUser).toHaveBeenCalledTimes(1);
    const [query, options] = signInWithCatalogUser.mock.calls[0];
    expect(query).toEqual({ entityRef: { name: 'octocat' } });
    // The M2 tightening: NO dangerousEntityRefFallback option is passed.
    expect(options).toBeUndefined();
  });

  it('lowercases the GitHub login before matching (case gotcha, R2)', async () => {
    await processOidcSignInResolver(
      infoWith({ preferred_username: 'OctoCat' }),
      ctx,
    );
    expect(signInWithCatalogUser).toHaveBeenCalledWith({
      entityRef: { name: 'octocat' },
    });
  });

  it('propagates the failure when no ingested User matches (no synthetic identity)', async () => {
    signInWithCatalogUser.mockRejectedValueOnce(
      new Error('no matching entity'),
    );
    await expect(
      processOidcSignInResolver(
        infoWith({ preferred_username: 'not-on-any-team' }),
        ctx,
      ),
    ).rejects.toThrow('no matching entity');
  });

  it('throws when the profile carries no usable login claim', async () => {
    await expect(
      processOidcSignInResolver(infoWith({}), ctx),
    ).rejects.toThrow(/missing preferred_username/);
    expect(signInWithCatalogUser).not.toHaveBeenCalled();
  });
});
