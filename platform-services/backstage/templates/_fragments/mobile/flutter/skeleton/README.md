# ${{ values.appName }} — Mobile app (Flutter / Dart)

${{ values.description }}

A cross-platform (iOS + Android) Flutter starter. It is a **build artifact (.apk / .ipa)**,
not a deployed service — there is **no Dockerfile and no Kubernetes Deployment**. It is
**distributed to devices** (TestFlight / Play / internal), not hosted in the cluster. Its
data comes from a **backend fragment** (express / fastapi / dotnet) deployed the normal
way; this app calls that backend over its **public ingress host**.

## Backend API base URL

Mobile apps run on devices, so they cannot use a same-origin relative `/api` path like a
web frontend. The base URL is `AppConfig.apiBaseUrl` (`lib/config.dart`), read from a
compile-time `--dart-define`. `lib/api_client.dart` calls `GET {API_BASE_URL}/healthz`.
Override per build: `flutter build apk --dart-define=API_BASE_URL=https://your-backend...`.

## Build

CI: `.mobile-ci/build.yaml` runs `flutter create .` to generate the native projects, then
builds a **debug `.apk`** on `ubuntu-latest` and validates the **iOS** build on a macOS
runner (`macos-14`, required for iOS).

Local: `flutter create . --platforms=android,ios && flutter pub get && flutter run`.

## Distribution (signed)

A distributable iOS `.ipa` needs `flutter build ipa` with Apple signing secrets; a signed
Android release needs a keystore (`flutter build appbundle`). Then upload to TestFlight /
the Play Console.
