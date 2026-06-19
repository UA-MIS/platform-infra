/*
 * Custom OIDC auth provider module for "The Process".
 *
 * Why a custom module (not the stock @backstage/plugin-auth-backend-module-oidc-provider
 * with a config resolver): the stock OIDC module only ships email-based config resolvers
 * (emailLocalPartMatchingUserEntityName, emailMatchingUserEntityProfileEmail). The Process
 * signs in via the shared Dex broker, which emits the GitHub login as `preferred_username`
 * (Dex `useLoginAsID`). M1 resolves that login -> a Backstage User entity.
 *
 * M2 TIGHTENS THE RESOLVER (this is the linchpin of the permission spine, see
 * artifacts/planning/M2-github-teams-visibility-plan.md §3.1). M1 used a catalog FALLBACK
 * (dangerousEntityRefFallback) because the seed catalog had only placeholder Users. That
 * fallback minted a synthetic identity whose ownershipEntityRefs carried ONLY the user's
 * own ref -- NO group memberships -- which would make the M2 permission policy inert
 * (everyone denied, no admin). M2 removes the fallback and resolves STRICTLY to a real
 * ingested catalog User (GitHub-org ingestion, see authOidcProcess's sibling githubOrg
 * provider) so Backstage derives ownershipEntityRefs from the User's spec.memberOf (the
 * GitHub teams) -> the policy's isEntityOwner({ claims }) becomes meaningful.
 *
 * BEHAVIOR CHANGE (acknowledged): a Dex-authenticated UA-MIS member who is NOT on any
 * ingested team can no longer sign in (signInWithCatalogUser throws "no matching entity").
 * This is the correct tightening; all real students are on a project team, and admins
 * (labmx) are org members on an ingested team so they resolve normally. Org gating remains
 * enforced UPSTREAM at Dex (SEC-007); Backstage trusts the broker for org membership.
 *
 * The provider id MUST be "oidc" so it matches auth.providers.oidc in app-config and the
 * Dex redirect URI (/api/auth/oidc/handler/frame). A code-defined signInResolver takes
 * effect only when app-config carries NO auth.providers.oidc.<env>.signIn.resolvers list
 * (config resolvers win) -- so app-config.production.yaml omits that list on purpose.
 */
import { createBackendModule } from '@backstage/backend-plugin-api';
import {
  authProvidersExtensionPoint,
  createOAuthProviderFactory,
  OAuthAuthenticatorResult,
  SignInResolver,
  SignInInfo,
  AuthResolverContext,
} from '@backstage/plugin-auth-node';
import {
  oidcAuthenticator,
  OidcAuthResult,
} from '@backstage/plugin-auth-backend-module-oidc-provider';
import { stringifyEntityRef } from '@backstage/catalog-model';

/**
 * The Dex sign-in resolver, extracted as a standalone function so it is unit-testable
 * (the linchpin of the M2 spine — see *.test.ts). Resolves the OIDC profile's GitHub login
 * (Dex preferred_username, on OidcAuthResult.userinfo) to a REAL ingested catalog User;
 * throws if none exists.
 */
export const processOidcSignInResolver: SignInResolver<
  OAuthAuthenticatorResult<OidcAuthResult>
> = async (
  info: SignInInfo<OAuthAuthenticatorResult<OidcAuthResult>>,
  ctx: AuthResolverContext,
) => {
  // Dex emits the GitHub login as preferred_username (useLoginAsID).
  const userinfo = info.result.fullProfile.userinfo;
  const rawLogin =
    (userinfo.preferred_username as string | undefined) ??
    (userinfo.name as string | undefined) ??
    userinfo.sub;

  if (!rawLogin) {
    throw new Error(
      'OIDC profile is missing preferred_username / name / sub; cannot resolve a Backstage user.',
    );
  }

  // Login-case gotcha (M2 R2): the github-org provider normalizes ingested
  // User.metadata.name to lowercase, but Dex's preferred_username is the GitHub login
  // as-is. Lowercase the login before matching so a user whose GitHub login has uppercase
  // characters still resolves to their ingested User.
  const login = rawLogin.toLowerCase();

  // Resolve the REAL ingested catalog User by name (GitHub login == the canonical User
  // entity name after GitHub-org ingestion). NO dangerousEntityRefFallback: resolving to a
  // real User is what populates ownershipEntityRefs (the user's group/team refs) so the M2
  // permission policy can filter by ownership. A login with no matching ingested User fails
  // sign-in by design (§3.1).
  //
  // Done in EXPLICIT steps (rather than the one-liner ctx.signInWithCatalogUser) so we can
  // log the resolved sub + ownership-ref count + the precise failing step. The sign-in
  // pipeline's frame handler swallows resolver throws into a client-side web-message (the
  // pod shows only "200 contentLength 0" with no server stack), so without this we are
  // blind to WHY a post-by-name step fails. console.* is captured by the backend root
  // logger, so these surface in pod logs WITHOUT a global debug-log flag. Behaviour on the
  // success path is identical to signInWithCatalogUser (same sub + ent claims).
  try {
    const { entity } = await ctx.findCatalogUser({ entityRef: { name: login } });
    const { ownershipEntityRefs } = await ctx.resolveOwnershipEntityRefs(entity);
    const sub = stringifyEntityRef(entity);
    // eslint-disable-next-line no-console
    console.info(
      `[authOidcProcess] resolved login=${login} -> sub=${sub} ` +
        `ownershipEntityRefs=${ownershipEntityRefs.length}`,
    );
    return await ctx.issueToken({ claims: { sub, ent: ownershipEntityRefs } });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[authOidcProcess] sign-in FAILED for login=${login}: ` +
        `${(error as Error)?.name}: ${(error as Error)?.message}`,
      error,
    );
    throw error;
  }
};

export const authModuleOidcProcess = createBackendModule({
  // Targets the core "auth" plugin.
  pluginId: 'auth',
  moduleId: 'oidc-process-provider',
  register(reg) {
    reg.registerInit({
      deps: { providers: authProvidersExtensionPoint },
      async init({ providers }) {
        providers.registerProvider({
          // Must be "oidc" to match the app-config provider key + the Dex redirect URI.
          providerId: 'oidc',
          factory: createOAuthProviderFactory({
            authenticator: oidcAuthenticator,
            signInResolver: processOidcSignInResolver,
          }),
        });
      },
    });
  },
});

export default authModuleOidcProcess;
