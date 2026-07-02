// ${{ values.appName }} frontend — the web/UI component of a multi-component capstone app.
//
// A minimal std-lib-only Go HTTP server that serves a single page at "/". The
// platform Ingress routes "/" to THIS component and "/api" to the backend, on the
// SAME host — so the page below fetches "/api/hello" from the browser and the
// Ingress sends that request to the backend. That round trip proves the
// "/"->frontend, "/api"->backend split works end to end.
//
// This is intentionally a tiny Go static server so the starter builds first-try on
// the platform (Go-on-scratch, no apt). Swap it for your real frontend (React, Vue,
// a node+nginx image, etc.) by replacing this code AND the frontend/Dockerfile — the
// platform contract only cares that the container serves "/" on the declared port.
//
//	GET /healthz : 200 "ok" — liveness/readiness; always up while the process is.
//	GET /        : 200 HTML — the page; its JS calls /api/hello (-> backend via Ingress).
package main

import (
	"log"
	"net/http"
	"os"
)

// page is the single static HTML document served at "/". Its inline script calls
// the backend through the SAME host at /api/hello, demonstrating the Ingress split.
const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${{ values.appName }}</title></head>
<body>
  <h1>${{ values.appName }}</h1>
  <p>frontend component is up. Calling the backend at <code>/api/hello</code>…</p>
  <pre id="out">loading…</pre>
  <script>
    fetch("/api/hello")
      .then(function (r) { return r.json(); })
      .then(function (j) { document.getElementById("out").textContent = JSON.stringify(j, null, 2); })
      .catch(function (e) { document.getElementById("out").textContent = "backend call failed: " + e; });
  </script>
</body>
</html>
`

// healthzHandler always returns 200 while the process is up — probes must not
// depend on app config or the backend being reachable.
func healthzHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// rootHandler serves the page at "/". It only handles the exact root path so an
// unknown path returns 404 rather than the page.
func rootHandler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(page))
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	http.HandleFunc("/healthz", healthzHandler)
	http.HandleFunc("/", rootHandler)

	log.Printf("${{ values.appName }} frontend listening on :%s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}
