# ${{ values.appName }} — Mobile app (React Native / Expo)

${{ values.description }}

A cross-platform (iOS + Android) React Native starter, built with Expo and TypeScript. It
is a **build artifact (.apk / .ipa)**, not a deployed service — there is **no Dockerfile
and no Kubernetes Deployment**. It is **distributed to devices** (TestFlight / Play /
internal), not hosted in the cluster. Its data comes from a **backend fragment** (express /
fastapi / dotnet) deployed the normal way; this app calls that backend over its **public
ingress host**.

## Backend API base URL

Mobile apps run on devices, so they cannot use a same-origin relative `/api` path like a
web frontend. Configure the backend's public URL in **`app.json`** →
`expo.extra.apiBaseUrl` (or override with the `EXPO_PUBLIC_API_BASE_URL` env var).
`src/config.ts` resolves it; the screen calls `GET {API_BASE_URL}/healthz`.

## Build

CI: `.mobile-ci/build.yaml` runs `expo prebuild` to generate the native projects, then
builds a **debug `.apk`** on `ubuntu-latest` and validates the **iOS** build on a macOS
runner (`macos-14`, required for iOS).

Local: `npm install && npx expo start` (Expo Go), or `npx expo run:android` /
`npx expo run:ios`.

## Distribution (signed)

The recommended path for signed `.ipa` / `.aab` artifacts is **EAS Build**
(`eas build -p ios|android`, needs an `EXPO_TOKEN`), then upload to TestFlight / the Play
Console. Alternatively, wire Apple / Play signing secrets into the workflow.
