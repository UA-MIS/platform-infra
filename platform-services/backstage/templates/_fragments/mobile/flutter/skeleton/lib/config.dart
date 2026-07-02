/// Backend API base URL.
///
/// Mobile apps are DISTRIBUTED to devices (TestFlight / Play), NOT served from the cluster,
/// so — unlike a web frontend — they cannot use a same-origin relative "/api" path. They
/// call the backend (a normal backend fragment: express/fastapi/dotnet) over its PUBLIC
/// ingress host. Override at build time:
///   flutter build apk --dart-define=API_BASE_URL=https://your-backend...
class AppConfig {
  static const String apiBaseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'https://CHANGEME-backend.capstone.uamishub.com',
  );
}
