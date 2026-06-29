# ${{ values.appName }} — Android app (Kotlin / Jetpack Compose)

${{ values.description }}

A native Android starter app. It is a **build artifact (.apk)**, not a deployed service —
there is **no Dockerfile and no Kubernetes Deployment**. It is **distributed to devices**
(Play Console / internal distribution), not hosted in the cluster. Its data comes from a
**backend fragment** (express / fastapi / dotnet) deployed the normal way; this app calls
that backend over its **public ingress host**.

## Backend API base URL

Mobile apps run on devices, so they cannot use a same-origin relative `/api` path like a
web frontend. The base URL is `BuildConfig.API_BASE_URL`, set from the `apiBaseUrl` Gradle
property (default in `app/build.gradle.kts`). `ApiClient.kt` calls
`GET {API_BASE_URL}/healthz`. Override per build: `gradle assembleDebug -PapiBaseUrl=https://your-backend...`.

## Build

CI: `.mobile-ci/build.yaml` runs on **`ubuntu-latest`** (no macOS needed), installs JDK 17
+ Gradle, and builds a **debug `.apk`** (auto-signed with the debug keystore) for
validation.

Local: `gradle assembleDebug` (or open the project in Android Studio).

## Distribution (signed)

A distributable release `.apk`/`.aab` needs a release signing keystore (add as repo
secrets), a `signingConfig` in `app/build.gradle.kts`, then `gradle bundleRelease` and
upload to the Play Console.
