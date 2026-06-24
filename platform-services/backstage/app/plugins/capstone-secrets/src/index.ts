/*
 * @internal/backstage-plugin-capstone-secrets — the write-only Secrets UX (M3).
 * Default export is the frontend plugin added in packages/app/src/App.tsx.
 */
export { capstoneSecretsPlugin, capstoneSecretsPlugin as default } from './plugin';
export {
  capstoneSecretsApiRef,
  CapstoneSecretsClient,
} from './api';
export type {
  CapstoneSecretsApi,
  SecretSummary,
  SealSecretRequest,
  SealSecretResult,
  ProjectSummary,
  DeleteSecretRequest,
  DeleteSecretResult,
} from './api';
