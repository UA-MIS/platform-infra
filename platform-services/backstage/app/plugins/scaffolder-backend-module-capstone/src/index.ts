/*
 * @internal/backstage-plugin-scaffolder-backend-module-capstone
 *
 * The shared capstone scaffolder backend module. Default export is the backend module added
 * in packages/backend/src/index.ts. Also re-exports the action factories + the secrets
 * permission so the app backend (and tests) can reference them.
 */
export { capstoneScaffolderModule, capstoneScaffolderModule as default } from './module';
export { createSealSecretAction } from './actions/sealSecret';
export type { SealSecretActionDeps } from './actions/sealSecret';
export { createRenderTenantAction } from './actions/renderTenant';
export type { RenderTenantActionDeps } from './actions/renderTenant';
export {
  createEmitTenantClaimAction,
  renderCapstoneTenant,
} from './actions/emitTenantClaim';
export {
  createHarborOnboardAction,
  ensureHarborProject,
  readHarborConfig,
  authorizeTeamOwnership,
} from './actions/harborOnboard';
export type {
  HarborOnboardActionDeps,
  HarborConfig,
  FetchLike,
} from './actions/harborOnboard';
export {
  sealSecretPermission,
  capstoneSecretsPermissions,
} from './permissions';
// The SHARED seal core (also used by the capstone-secrets backend route, so the action and
// the route enforce ONE authz + seal implementation — team-lead's Option A requirement).
export {
  sealAndPublish,
  listSecrets,
  listMyProjects,
  deleteSecret,
  ADMIN_GROUP_REF,
} from './sealCore';
export type {
  CapstoneSecretsDeps,
  SealRequest,
  ListRequest,
  SecretSummary,
  ListProjectsRequest,
  ProjectSummary,
  DeleteRequest,
} from './sealCore';
