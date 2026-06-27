// ${{ values.appName }} backend — the API component of a multi-component capstone app.
//
// A minimal std-lib-only Go HTTP API. The platform Ingress routes "/api" to THIS
// component (and "/" to the frontend), so every route here is registered UNDER
// "/api" — the Ingress does NOT strip the prefix, the backend pod receives the full
// path (e.g. GET /api/hello). Edit this freely — it is YOUR code. (Do not edit
// .devops/ or the component routing in .devops/components.yaml unless you mean to.)
//
//	GET /healthz   : 200 "ok" — liveness/readiness. Probes hit the pod DIRECTLY (not
//	                 through the Ingress), so this stays at the container root and is
//	                 the SAME probe path for every component, even though the Ingress
//	                 only routes /api here.
//	GET /api/hello : 200 JSON — proves it read APP_SECRET WITHOUT echoing the value;
//	                 the frontend fetches this to prove the / vs /api split works.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
)

// healthzHandler always returns 200 while the process is up — probes must not
// depend on app config or secret state.
func healthzHandler(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}

// helloHandler proves it read APP_SECRET WITHOUT leaking the value: it returns
// bool + length + an 8-char sha256 prefix, never the secret itself.
func helloHandler(w http.ResponseWriter, r *http.Request) {
	secret := os.Getenv("APP_SECRET")
	sum := sha256.Sum256([]byte(secret))
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"component":    "backend",
		"app":          "${{ values.appName }}",
		"message":      "hello from the ${{ values.appName }} backend",
		"secretLoaded": secret != "",
		"secretLength": len(secret),
		"secretSha256": hex.EncodeToString(sum[:])[:8],
	})
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Probe path at the container root (direct-to-pod, uniform across components).
	http.HandleFunc("/healthz", healthzHandler)
	// API routes live under /api — the Ingress sends "/api" here without stripping it.
	http.HandleFunc("/api/hello", helloHandler)

	log.Printf("${{ values.appName }} backend listening on :%s (routes under /api)", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}
