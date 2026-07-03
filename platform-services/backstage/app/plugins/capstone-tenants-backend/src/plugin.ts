/*
 * The capstone-tenants BACKEND plugin — serves the admin Tenant Teardown page's GET /tenants +
 * POST /teardown. A thin HTTP front for the SHARED teardownCore (in the scaffolder module),
 * injecting the same services the secrets route gets so authz stays in ONE place. Added in
 * packages/backend/src/index.ts AFTER the permission plugin (it calls the permission framework).
 */
import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { createRouter } from './service/router';

export const capstoneTenantsPlugin = createBackendPlugin({
  pluginId: 'capstone-tenants',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        permissions: coreServices.permissions,
        auth: coreServices.auth,
        catalog: catalogServiceRef,
      },
      async init({
        httpRouter,
        httpAuth,
        config,
        logger,
        permissions,
        auth,
        catalog,
      }) {
        httpRouter.use(
          await createRouter({
            httpAuth,
            config,
            logger,
            permissions,
            auth,
            catalog,
          }),
        );
      },
    });
  },
});

export default capstoneTenantsPlugin;
