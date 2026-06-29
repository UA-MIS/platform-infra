import Foundation

/// Resolves the backend API base URL.
///
/// Mobile apps are DISTRIBUTED to devices (TestFlight / App Store), NOT served from the
/// cluster, so — unlike a web frontend — they cannot use a same-origin relative "/api"
/// path. They must call the backend (a normal backend fragment: express/fastapi/dotnet)
/// over its PUBLIC ingress host. Set API_BASE_URL in project.yml (it lands in the
/// generated Info.plist) to your backend fragment's public URL.
enum AppConfig {
    static let fallbackBaseURL = "https://CHANGEME-backend.capstone.uamishub.com"

    static var apiBaseURL: URL {
        let value = (Bundle.main.object(forInfoDictionaryKey: "API_BASE_URL") as? String) ?? fallbackBaseURL
        return URL(string: value) ?? URL(string: fallbackBaseURL)!
    }
}
