/*
 * @internal/backstage-plugin-capstone-tenants — the admin Tenant Teardown page.
 * Default export is the frontend plugin added in packages/app/src/App.tsx.
 */
export { capstoneTenantsPlugin, capstoneTenantsPlugin as default } from './plugin';
export { capstoneTenantsApiRef, CapstoneTenantsClient } from './api';
export type {
  CapstoneTenantsApi,
  TenantSummary,
  TeardownRequest,
  TeardownResult,
} from './api';
