import 'package:http/http.dart' as http;

import 'config.dart';

class ApiClient {
  /// Calls GET {API_BASE_URL}/healthz on the backend fragment (a normal backend fragment:
  /// express/fastapi/dotnet). The backend MUST expose a DB-independent GET /healthz that
  /// returns 200 (see ADR-034). Returns "HTTP <code>\n<body>" or a failure message.
  static Future<String> health() async {
    final base = AppConfig.apiBaseUrl.replaceAll(RegExp(r'/+$'), '');
    final uri = Uri.parse('$base/healthz');
    try {
      final res = await http.get(uri).timeout(const Duration(seconds: 10));
      return 'HTTP ${res.statusCode}\n${res.body}';
    } catch (e) {
      return 'Request failed: $e';
    }
  }
}
