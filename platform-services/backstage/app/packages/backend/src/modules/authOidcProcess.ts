/*
 * Custom OIDC auth provider module for "The Process".
 *
 * Why a custom module (not the stock @backstage/plugin-auth-backend-module-oidc-provider
 * with a config resolver): the stock OIDC module only ships email-based config resolvers
 * (emailLocalPartMatchingUserEntityName, emailMatchingUserEntityProfileEmail). The Process
 * signs in via the shared Dex broker, which emits the GitHub login as `preferred_username`
 * (Dex `useLoginAsID`). M1 resolves that login -> a Backstage User entity.
 *
 * M1 deliberately uses a catalog FALLBACK (dangerousEntityRefFallback): real GitHub-org
 * catalog ingestion arrives in M2. Until then the seed catalog has only placeholder Users,
 * so a real UA-MIS member would not yet have a matching User entity. The fallback lets a
 * Dex-authenticated (== UA-MIS-org-gated, SEC-007) member sign in and the portal render --
 * which is exactly M1's "see it work" checkpoint. Org gating is enforced UPSTREAM at Dex;
 * Backstage trusts the broker. M2 tightens this to require a catalog User.
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
} from '@backstage/plugin-auth-node';
import { oidcAuthenticator } from '@backstage/plugin-auth-backend-module-oidc-provider';

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
            async signInResolver(info, ctx) {
              // Dex emits the GitHub login as preferred_username (useLoginAsID).
              const userinfo = info.result.fullProfile.userinfo;
              const login =
                (userinfo.preferred_username as string | undefined) ??
                (userinfo.name as string | undefined) ??
                userinfo.sub;

              if (!login) {
                throw new Error(
                  'OIDC profile is missing preferred_username / name / sub; cannot resolve a Backstage user.',
                );
              }

              // Match a catalog User by name (the GitHub login == the canonical User
              // entity name once GitHub-org ingestion lands in M2). M1: fall back to a
              // synthetic User ref so a Dex-authenticated member can sign in before the
              // real catalog Users exist.
              return ctx.signInWithCatalogUser(
                { entityRef: { name: login } },
                {
                  dangerousEntityRefFallback: {
                    entityRef: { name: login },
                  },
                },
              );
            },
          }),
        });
      },
    });
  },
});

export default authModuleOidcProcess;
