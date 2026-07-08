// The UA-MIS theme for The Process — matches the ArgoCD / Grafana look (crimson primary +
// charcoal surfaces) so the whole platform reads as one system. See colors.ts for the
// shared palette values and platform-services/argocd-config/ua-mis.css for the reference
// implementation these were lifted from.
import {
  createBaseThemeOptions,
  createUnifiedTheme,
  genPageTheme,
  palettes,
  shapes,
} from '@backstage/theme';
import {
  uamisCharcoal,
  uamisCharcoalHover,
  uamisCrimson,
  uamisCrimsonDark,
  uamisLightText,
} from './colors';

// One crimson->charcoal gradient, reused for every page-header "kind" (home, service,
// documentation, etc.) rather than Backstage's default per-kind rainbow — keeps every page
// header on-brand instead of introducing colors that don't appear anywhere else in the
// platform.
const uamisPageTheme = genPageTheme({
  colors: [uamisCrimson, uamisCharcoal],
  shape: shapes.wave,
});

const uamisPageThemes = {
  home: uamisPageTheme,
  app: uamisPageTheme,
  apis: uamisPageTheme,
  documentation: uamisPageTheme,
  tool: uamisPageTheme,
  service: uamisPageTheme,
  website: uamisPageTheme,
  library: uamisPageTheme,
  other: uamisPageTheme,
};

export const uamisLightTheme = createUnifiedTheme({
  ...createBaseThemeOptions({
    palette: {
      ...palettes.light,
      primary: {
        main: uamisCrimson,
        dark: uamisCrimsonDark,
      },
      secondary: {
        main: uamisCharcoal,
      },
      navigation: {
        background: uamisCharcoal,
        indicator: uamisCrimson,
        color: uamisLightText,
        selectedColor: '#FFFFFF',
        navItem: {
          hoverBackground: uamisCharcoalHover,
        },
      },
    },
  }),
  defaultPageTheme: 'home',
  pageTheme: uamisPageThemes,
});

export const uamisDarkTheme = createUnifiedTheme({
  ...createBaseThemeOptions({
    palette: {
      ...palettes.dark,
      primary: {
        main: uamisCrimson,
        dark: uamisCrimsonDark,
      },
      secondary: {
        main: uamisLightText,
      },
      background: {
        default: uamisCharcoal,
        paper: uamisCharcoalHover,
      },
      navigation: {
        background: uamisCharcoal,
        indicator: uamisCrimson,
        color: uamisLightText,
        selectedColor: '#FFFFFF',
        navItem: {
          hoverBackground: uamisCharcoalHover,
        },
      },
    },
  }),
  defaultPageTheme: 'home',
  pageTheme: uamisPageThemes,
});
