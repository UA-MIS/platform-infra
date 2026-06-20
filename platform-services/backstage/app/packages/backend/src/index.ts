/*
 * Hi!
 *
 * Note that this is an EXAMPLE Backstage backend. Please check the README.
 *
 * Happy hacking!
 */

import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-app-backend'));
backend.add(import('@backstage/plugin-proxy-backend'));

// scaffolder plugin
backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend-module-github'));
backend.add(
  import('@backstage/plugin-scaffolder-backend-module-notifications'),
);
// The SHARED capstone scaffolder actions module: M3 `capstone:seal-secret` (secrets
// sealing -> PR) + M4 `capstone:render-tenant` (onboarding). One module, multiple actions
// (plugins/scaffolder-backend-module-capstone). Must come AFTER the scaffolder plugin so
// its extension point exists.
backend.add(
  import('@internal/backstage-plugin-scaffolder-backend-module-capstone'),
);

// techdocs plugin
backend.add(import('@backstage/plugin-techdocs-backend'));

// auth plugin
backend.add(import('@backstage/plugin-auth-backend'));
// The Process signs in via the shared Dex broker (OIDC). This custom module wires the
// "oidc" provider with a Dex-aware sign-in resolver (preferred_username -> User entity).
// See packages/backend/src/modules/authOidcProcess.ts for why it is custom, not stock.
backend.add(import('./modules/authOidcProcess'));

// catalog plugin
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(
  import('@backstage/plugin-catalog-backend-module-scaffolder-entity-model'),
);

// M2: GitHub-org ingestion — one Backstage Group per GitHub team (slug = <team>) + one
// User per org member with spec.memberOf, driven by catalog.providers.githubOrg in
// app-config. This is what populates the ownership data the permission policy filters on.
backend.add(import('@backstage/plugin-catalog-backend-module-github-org'));

// See https://backstage.io/docs/features/software-catalog/configuration#subscribing-to-catalog-errors
backend.add(import('@backstage/plugin-catalog-backend-module-logs'));

// permission plugin
backend.add(import('@backstage/plugin-permission-backend'));
// M2: the custom CapstoneTeamPermissionPolicy (THE SPINE) — per-team catalog visibility
// via ownership filtering, admin override on the `labmx` group. REPLACES the stock
// allow-all policy (only one policy can be set; the allow-all module is removed and its
// dependency dropped from package.json). Requires permission.enabled: true in app-config.
backend.add(import('./modules/permissionPolicy'));

// search plugin
backend.add(import('@backstage/plugin-search-backend'));

// search engine
// See https://backstage.io/docs/features/search/search-engines
backend.add(import('@backstage/plugin-search-backend-module-pg'));

// search collators
backend.add(import('@backstage/plugin-search-backend-module-catalog'));
backend.add(import('@backstage/plugin-search-backend-module-techdocs'));

// kubernetes plugin
backend.add(import('@backstage/plugin-kubernetes-backend'));

// notifications and signals plugins
backend.add(import('@backstage/plugin-notifications-backend'));
backend.add(import('@backstage/plugin-signals-backend'));

// mcp actions plugin
backend.add(import('@backstage/plugin-mcp-actions-backend'));

backend.start();
