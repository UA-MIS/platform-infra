import { API_BASE_URL } from './config';

// Calls GET {API_BASE_URL}/healthz on the backend fragment (a normal backend fragment:
// express/fastapi/dotnet). The backend MUST expose a DB-independent GET /healthz that
// returns 200 (see ADR-034). Returns "HTTP <code>\n<body>" or a failure message.
export async function health(): Promise<string> {
  const base = API_BASE_URL.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/healthz`);
    const body = await res.text();
    return `HTTP ${res.status}\n${body}`;
  } catch (e) {
    return `Request failed: ${String(e)}`;
  }
}
