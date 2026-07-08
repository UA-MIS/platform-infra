import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { ThemeBlueprint } from '@backstage/plugin-app-react';
import { UnifiedThemeProvider } from '@backstage/theme';
import Brightness7Icon from '@material-ui/icons/Brightness7';
import Brightness4Icon from '@material-ui/icons/Brightness4';
import { uamisDarkTheme, uamisLightTheme } from './uamisTheme';

const uamisLightThemeExtension = ThemeBlueprint.make({
  name: 'uamis-light',
  params: {
    theme: {
      id: 'uamis-light',
      title: 'UA-MIS Light',
      variant: 'light',
      icon: <Brightness7Icon />,
      Provider: ({ children }) => (
        <UnifiedThemeProvider theme={uamisLightTheme} children={children} />
      ),
    },
  },
});

const uamisDarkThemeExtension = ThemeBlueprint.make({
  name: 'uamis-dark',
  params: {
    theme: {
      id: 'uamis-dark',
      title: 'UA-MIS Dark',
      variant: 'dark',
      icon: <Brightness4Icon />,
      Provider: ({ children }) => (
        <UnifiedThemeProvider theme={uamisDarkTheme} children={children} />
      ),
    },
  },
});

// Registered as the 'app' plugin, same as the nav/signIn modules — these are app-wide
// customizations, not a standalone plugin's feature.
export const themeModule = createFrontendModule({
  pluginId: 'app',
  extensions: [uamisLightThemeExtension, uamisDarkThemeExtension],
});
