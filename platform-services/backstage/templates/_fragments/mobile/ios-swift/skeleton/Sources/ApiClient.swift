import Foundation

/// Minimal client for the backend fragment's API.
enum ApiClient {
    /// Calls GET {API_BASE_URL}/healthz. The backend (a normal backend fragment) MUST
    /// expose a DB-independent GET /healthz that returns 200 (see ADR-034). Returns the
    /// HTTP status code and the response body.
    static func health() async throws -> (status: Int, body: String) {
        let url = AppConfig.apiBaseURL.appendingPathComponent("healthz")
        let (data, response) = try await URLSession.shared.data(from: url)
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        let body = String(data: data, encoding: .utf8) ?? ""
        return (status, body)
    }
}
