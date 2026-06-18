// ${{ values.appName }} — UA-MIS capstone starter service.
//
// A minimal std-lib-only Go HTTP service that proves the golden path end to end:
// PR -> preview, merge -> dev, tag -> staging, manual gate -> prod, reading a Sealed
// Secret along the way. Edit this freely — it is YOUR app code. (Do not edit .devops/.)
//
//	GET /healthz : 200 "ok" — liveness/readiness; always up while the process is.
//	GET /        : 200 — proves it read APP_SECRET WITHOUT echoing the value.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
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

// rootHandler proves it read APP_SECRET WITHOUT leaking the value: bool + length
// + an 8-char sha256 prefix.
func rootHandler(w http.ResponseWriter, r *http.Request) {
	secret := os.Getenv("APP_SECRET")
	loaded := secret != ""
	sum := sha256.Sum256([]byte(secret))
	fmt.Fprintf(w, "app: ${{ values.appName }}\nsecret loaded: %v, length=%d, sha256=%s\n",
		loaded, len(secret), hex.EncodeToString(sum[:])[:8])
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "${{ values.port }}"
	}

	http.HandleFunc("/healthz", healthzHandler)
	http.HandleFunc("/", rootHandler)

	log.Printf("${{ values.appName }} listening on :%s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}
