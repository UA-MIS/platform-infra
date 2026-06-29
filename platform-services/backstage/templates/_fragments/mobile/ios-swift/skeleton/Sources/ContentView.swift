import SwiftUI

/// The single starter screen: shows the configured backend base URL and pings it.
struct ContentView: View {
    @State private var result = "Tap to call the backend."
    @State private var loading = false

    var body: some View {
        VStack(spacing: 16) {
            Text("${{ values.appName }}")
                .font(.largeTitle).bold()
            Text("${{ values.description }}")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Text("Backend: \(AppConfig.apiBaseURL.absoluteString)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button(action: ping) {
                Text(loading ? "Calling…" : "Ping backend /healthz")
            }
            .buttonStyle(.borderedProminent)
            .disabled(loading)
            Text(result)
                .font(.callout)
                .multilineTextAlignment(.center)
        }
        .padding()
    }

    private func ping() {
        loading = true
        result = "Calling \(AppConfig.apiBaseURL.absoluteString)/healthz …"
        Task {
            do {
                let (status, body) = try await ApiClient.health()
                result = "HTTP \(status)\n\(body)"
            } catch {
                result = "Request failed: \(error.localizedDescription)"
            }
            loading = false
        }
    }
}
