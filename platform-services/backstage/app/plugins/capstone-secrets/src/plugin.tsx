/*
 * The capstone-secrets FRONTEND plugin (new frontend system, plan §3). Exposes:
 *  - an API factory (capstoneSecretsApiRef -> the REST client),
 *  - an entity "Secrets" tab on Component entities (the primary write-only UX),
 *  - a standalone "/secrets" nav page (fallback, points at the entity tab).
 * Registered in packages/app/src/App.tsx via createApp({ features: [...] }).
 */
import {
  ApiBlueprint,
  PageBlueprint,
  createApiFactory,
  createFrontendPlugin,
  discoveryApiRef,
  fetchApiRef,
} from '@backstage/frontend-plugin-api';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';
import SecurityIcon from '@material-ui/icons/Security';
import {
  capstoneSecretsApiRef,
  CapstoneSecretsClient,
} from './api';
import { rootRouteRef } from './routes';

const capstoneSecretsApi = ApiBlueprint.make({
  params: defineParams =>
    defineParams(
      createApiFactory({
        api: capstoneSecretsApiRef,
        deps: { discoveryApi: discoveryApiRef, fetchApi: fetchApiRef },
        factory: ({ discoveryApi, fetchApi }) =>
          new CapstoneSecretsClient({ discoveryApi, fetchApi }),
      }),
    ),
});

const secretsPage = PageBlueprint.make({
  params: {
    routeRef: rootRouteRef,
    path: '/secrets',
    loader: () =>
      import('./components/SecretsPage').then(m => <m.SecretsPage />),
  },
});

const secretsEntityContent = EntityContentBlueprint.make({
  name: 'secrets',
  params: {
    path: 'secrets',
    title: 'Secrets',
    icon: <SecurityIcon />,
    // Only on Component entities (where secrets are scoped, ADR-029 §4.3).
    filter: 'kind:component',
    loader: () =>
      import('./components/SecretsEntityContent').then(m => (
        <m.SecretsEntityContent />
      )),
  },
});

export const capstoneSecretsPlugin = createFrontendPlugin({
  pluginId: 'capstone-secrets',
  extensions: [capstoneSecretsApi, secretsPage, secretsEntityContent],
  routes: {
    root: rootRouteRef,
  },
});

export default capstoneSecretsPlugin;
