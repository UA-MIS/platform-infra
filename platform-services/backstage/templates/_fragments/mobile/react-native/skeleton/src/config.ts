import Constants from 'expo-constants';

// Backend API base URL.
//
// Mobile apps are DISTRIBUTED to devices (TestFlight / Play), NOT served from the cluster,
// so — unlike a web frontend — they cannot use a same-origin relative "/api" path. They
// call the backend (a normal backend fragment: express/fastapi/dotnet) over its PUBLIC
// ingress host. Configure it in app.json -> expo.extra.apiBaseUrl, or override at build
// time with the EXPO_PUBLIC_API_BASE_URL env var.
const fromExtra = (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)?.apiBaseUrl;

export const API_BASE_URL: string =
  process.env.EXPO_PUBLIC_API_BASE_URL ??
  fromExtra ??
  'https://CHANGEME-backend.capstone.uamishub.com';
