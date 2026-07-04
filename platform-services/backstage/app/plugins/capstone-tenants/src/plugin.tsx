/*
 * The capstone-tenants FRONTEND plugin (new frontend system). Exposes:
 *  - an API factory (capstoneTenantsApiRef -> the REST client),
 *  - a standalone "/admin/tenants" nav page (the admin Tenant Teardown UI).
 * Registered in packages/app/src/App.tsx via createApp({ features: [...] }).
 *
 * There is NO entity tab (unlike Secrets): teardown is a cross-tenant admin surface, not a
 * per-Component action. The page itself is usable by anyone, but the backend gates every call
 * ADMIN-ONLY — a non-admin sees an empty list + a 403 on any teardown attempt.
 */
import {
  ApiBlueprint,
  PageBlueprint,
  createApiFactory,
  createFrontendPlugin,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/frontend-plugin-api';
import DeleteSweepIcon from '@material-ui/icons/DeleteSweep';
import { capstoneTenantsApiRef, CapstoneTenantsClient } from './api';
import { rootRouteRef } from './routes';

const capstoneTenantsApi = ApiBlueprint.make({
  params: defineParams =>
    defineParams(
      createApiFactory({
        api: capstoneTenantsApiRef,
        deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
        factory: ({ discoveryApi, fetchApi }) =>
          new CapstoneTenantsClient({ discoveryApi, fetchApi }),
      }),
    ),
});

const tenantAdminPage = PageBlueprint.make({
  params: {
    routeRef: rootRouteRef,
    path: '/admin/tenants',
    // title + icon make the new frontend system auto-register a sidebar item (rendered by
    // Sidebar.tsx via nav.rest()).
    title: 'Tenant Admin',
    icon: <DeleteSweepIcon />,
    loader: () =>
      import('./components/TenantAdminPage').then(m => <m.TenantAdminPage />),
  },
});

export const capstoneTenantsPlugin = createFrontendPlugin({
  pluginId: 'capstone-tenants',
  extensions: [capstoneTenantsApi, tenantAdminPage],
  routes: {
    root: rootRouteRef,
  },
});

export default capstoneTenantsPlugin;
