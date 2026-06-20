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
export {
  sealSecretPermission,
  capstoneSecretsPermissions,
} from './permissions';
