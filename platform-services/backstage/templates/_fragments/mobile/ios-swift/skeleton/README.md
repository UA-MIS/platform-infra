# ${{ values.appName }} — iOS app (Swift / SwiftUI)

${{ values.description }}

A native iOS starter app. It is a **build artifact (.ipa)**, not a deployed service —
there is **no Dockerfile and no Kubernetes Deployment**. It is **distributed to devices**
(TestFlight / the App Store), not hosted in the cluster. Its data comes from a **backend
fragment** (express / fastapi / dotnet) deployed the normal way; this app calls that
backend over its **public ingress host**.

## Backend API base URL

Mobile apps run on devices, so they cannot use a same-origin relative `/api` path like a
web frontend. Set the backend's public URL in **`project.yml`** (the `API_BASE_URL`
property → generated `Info.plist`). `Sources/AppConfig.swift` reads it; the screen calls
`GET {API_BASE_URL}/healthz`.

## Build

CI: `.mobile-ci/build.yaml` runs on a **macOS runner** (`macos-14` — required for iOS),
generates the Xcode project with XcodeGen, and archives an **unsigned `.ipa`** for build
validation.

Local: `brew install xcodegen && xcodegen generate && open App.xcodeproj`.

## Distribution (signed)

A distributable `.ipa` needs Apple code-signing: add a signing certificate + provisioning
profile as repo secrets, export with an `ExportOptions.plist`, then upload to TestFlight /
the App Store.
