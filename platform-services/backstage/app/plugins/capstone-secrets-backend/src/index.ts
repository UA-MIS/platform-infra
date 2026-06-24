/*
 * @internal/backstage-plugin-capstone-secrets-backend — the Secrets page's backend route
 * (POST /seal, GET /list). Default export is the backend plugin added in
 * packages/backend/src/index.ts.
 */
export { capstoneSecretsPlugin, capstoneSecretsPlugin as default } from './plugin';
export { createRouter } from './service/router';
