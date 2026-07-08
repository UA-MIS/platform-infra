/*
 * The Process landing page (new frontend system). Mounted at the app root ("/", see
 * app-config.yaml `app.extensions: [page:home]`) in place of the default catalog-as-root.
 * Structured the same way as plugins/capstone-tenants (its own pluginId + PageBlueprint)
 * rather than as a createFrontendModule like nav/signIn, because it needs its own routeRef
 * and extension id (page:home) for the app-config path override to target.
 */
import {
  PageBlueprint,
  createFrontendPlugin,
} from '@backstage/frontend-plugin-api';
import HomeIcon from '@material-ui/icons/Home';
import { rootRouteRef } from './routes';

const homePage = PageBlueprint.make({
  params: {
    routeRef: rootRouteRef,
    // Default path if app-config didn't override it; app-config.yaml pins this to '/'.
    path: '/home',
    title: 'Home',
    icon: <HomeIcon />,
    loader: () => import('./HomePage').then(m => <m.HomePage />),
  },
});

export const homePlugin = createFrontendPlugin({
  pluginId: 'home',
  extensions: [homePage],
  routes: {
    root: rootRouteRef,
  },
});

export default homePlugin;
