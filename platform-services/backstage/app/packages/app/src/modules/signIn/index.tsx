/*
 * Sign-in page for "The Process" wired to the shared Dex broker over OIDC.
 *
 * The new frontend system has no default sign-in page, so we register a SignInPage
 * extension plus an OAuth2 ApiBlueprint for the generic OIDC provider. The provider id
 * MUST be "oidc" so it lines up with the backend module (providerId: 'oidc') and the Dex
 * redirect URI (/api/auth/oidc/handler/frame). The metadataUrl / clientId / clientSecret
 * live in app-config (auth.providers.oidc); this only drives the browser-side flow.
 */
import {
  OpenIdConnectApi,
  ProfileInfoApi,
  BackstageIdentityApi,
  SessionApi,
} from '@backstage/core-plugin-api';
import { OAuth2 } from '@backstage/core-app-api';
import { SignInPage } from '@backstage/core-components';
import { SignInPageBlueprint } from '@backstage/plugin-app-react';
import {
  ApiBlueprint,
  configApiRef,
  createApiRef,
  createFrontendModule,
  discoveryApiRef,
  oauthRequestApiRef,
} from '@backstage/frontend-plugin-api';

// A dedicated API ref for the Dex/OIDC auth client used by the sign-in page.
export const oidcAuthApiRef = createApiRef<
  OpenIdConnectApi & ProfileInfoApi & BackstageIdentityApi & SessionApi
>({
  id: 'auth.oidc',
});

const oidcAuthApi = ApiBlueprint.make({
  name: 'oidc',
  params: defineParams =>
    defineParams({
      api: oidcAuthApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        oauthRequestApi: oauthRequestApiRef,
        configApi: configApiRef,
      },
      factory: ({ discoveryApi, oauthRequestApi, configApi }) =>
        OAuth2.create({
          configApi,
          discoveryApi,
          oauthRequestApi,
          environment: configApi.getOptionalString('auth.environment'),
          provider: {
            // MUST be 'oidc' to match the backend provider + Dex redirect URI.
            id: 'oidc',
            title: 'The Process (Dex)',
            icon: () => null,
          },
          // offline_access makes Dex issue a refresh token so the session can be refreshed
          // (without it: no refresh cookie -> /api/auth/oidc/refresh 401 -> sign-in loop).
          // The backend provider also sets additionalScopes:['offline_access'] (the two are
          // unioned); keeping both in sync makes the requested scope explicit on each side.
          defaultScopes: ['openid', 'profile', 'email', 'offline_access'],
        }),
    }),
});

const signInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => props =>
      (
        <SignInPage
          {...props}
          auto
          provider={{
            id: 'oidc',
            title: 'The Process',
            message: 'Sign in with your UA-MIS GitHub account',
            apiRef: oidcAuthApiRef,
          }}
        />
      ),
  },
});

export const signInModule = createFrontendModule({
  pluginId: 'app',
  extensions: [oidcAuthApi, signInPage],
});

export default signInModule;
