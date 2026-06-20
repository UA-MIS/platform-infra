/*
 * The capstone-secrets BACKEND plugin (M3) — serves the Secrets page's POST /seal + GET /list
 * (plan §3, team-lead Option A). It is a thin HTTP front for the SHARED sealCore (in the
 * scaffolder module), injecting the same services the scaffolder action gets so both enforce
 * one authz + seal path. Added in packages/backend/src/index.ts.
 */
import {
  coreServices,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { createRouter } from './service/router';

export const capstoneSecretsPlugin = createBackendPlugin({
  pluginId: 'capstone-secrets',
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

export default capstoneSecretsPlugin;
