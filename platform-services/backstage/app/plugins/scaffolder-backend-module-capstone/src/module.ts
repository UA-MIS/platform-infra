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
import { createHarborOnboardAction } from './actions/harborOnboard';
import { createEmitTenantClaimAction } from './actions/emitTenantClaim';

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
          // Harbor onboarding — create the team's Harbor project + OIDC Developer
          // mapping at scaffold time (config-driven; least-privilege provisioner robot)
          // so the team's first CI build can push. Idempotent (already-exists = OK).
          // catalog+auth: the SEC-020 initiator-owns-team access-control check.
          createHarborOnboardAction({ config, catalog, auth }),
          // ADR-031 (track-5, Crossplane zero-touch onboarding): emit the ONE
          // CapstoneTenant XR. The Phase-2 template cutover swaps the imperative
          // harbor-onboard + render-tenant + onboarding-PR steps for this single
          // emit + a commit to tenants/_claims/ on main. NOT wired into the live
          // template until Crossplane is installed + a hand-applied XR is proven
          // (ADR-031 §11 Phase 2) — see CROSSPLANE-CUTOVER.md. Registering it now is
          // inert (no template references it yet) and ships the capability.
          createEmitTenantClaimAction(),
        );
      },
    });
  },
});

export default capstoneScaffolderModule;
