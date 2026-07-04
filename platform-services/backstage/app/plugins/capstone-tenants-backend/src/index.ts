/*
 * @internal/backstage-plugin-capstone-tenants-backend — backend route for the admin Tenant
 * Teardown page (GET /tenants, POST /teardown); thin front for the shared teardownCore.
 * Default export is the backend plugin added in packages/backend/src/index.ts.
 */
export { capstoneTenantsPlugin, capstoneTenantsPlugin as default } from './plugin';
