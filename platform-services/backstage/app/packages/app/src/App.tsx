import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import { navModule } from './modules/nav';
import { signInModule } from './modules/signIn';
// M3: the write-only Secrets capability — adds a "/secrets" page + a "Secrets" tab on
// Component entities (seal a secret -> PR to the team app repo). See
// plugins/capstone-secrets.
import capstoneSecretsPlugin from '@internal/backstage-plugin-capstone-secrets';

export default createApp({
  features: [catalogPlugin, navModule, signInModule, capstoneSecretsPlugin],
});
