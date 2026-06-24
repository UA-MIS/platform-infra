import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
// M4: the Scaffolder frontend — mounts the /create ScaffolderPage route (the golden-path
// "New Capstone Project" wizard) + the "Create" sidebar item. In the new frontend system a
// plugin that provides a page auto-registers its route + nav extension, so adding it here is
// all that's needed (Sidebar.tsx already does nav.take('page:scaffolder')). M1/M2 had no
// templates so this was never mounted; M4 added the backend action + template but not the
// frontend route — without this, /create 404s and there is no Create nav item.
import scaffolderPlugin from '@backstage/plugin-scaffolder/alpha';
import { navModule } from './modules/nav';
import { signInModule } from './modules/signIn';
// M3: the write-only Secrets capability — adds a "/secrets" page + a "Secrets" tab on
// Component entities (seal a secret -> PR to the team app repo). See
// plugins/capstone-secrets.
import capstoneSecretsPlugin from '@internal/backstage-plugin-capstone-secrets';

export default createApp({
  features: [
    catalogPlugin,
    scaffolderPlugin,
    navModule,
    signInModule,
    capstoneSecretsPlugin,
  ],
});
