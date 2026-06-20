/*
 * The SHARED capstone scaffolder backend module (ADR-029 §6, team-lead's call): all custom
 * capstone scaffolder actions live here, registered together via one createBackendModule so
 * `packages/backend/src/index.ts` adds a single module.
 *
 *   - M3 (this PR): `capstone:seal-secret` (createSealSecretAction) — the secrets capability.
 *   - M4 (m4-dev):  `capstone:render-tenant` (createRenderTenantAction) — onboarding render.
 *
 * To add an action: import its factory, give it its deps from the registerInit `deps` block
 * below (add the service ref to `deps` if it needs a new one), and pass it to `addActions`.
 * Keep each action in its own file under src/actions/ so the two milestones don't collide.
 */
import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { createSealSecretAction } from './actions/sealSecret';
import { createRenderTenantAction } from './actions/renderTenant';

export const capstoneScaffolderModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'capstone-actions',
  register({ registerInit }) {
    registerInit({
      deps: {
        scaffolder: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        catalog: catalogServiceRef,
        permissions: coreServices.permissions,
        auth: coreServices.auth,
        // M4: capstone:render-tenant reads the tenants/_template/ tree over HTTP.
        urlReader: coreServices.urlReader,
      },
      async init({
        scaffolder,
        config,
        logger,
        catalog,
        permissions,
        auth,
        urlReader,
      }) {
        scaffolder.addActions(
          createSealSecretAction({
            config,
            logger,
            catalog,
            permissions,
            auth,
          }),
          // M4 — capstone:render-tenant (m4-dev owns renderTenant.ts).
          createRenderTenantAction({ reader: urlReader }),
        );
      },
    });
  },
});

export default capstoneScaffolderModule;
