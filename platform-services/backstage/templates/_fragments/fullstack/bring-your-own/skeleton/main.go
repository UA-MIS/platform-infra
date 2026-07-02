// main.go — PLACEHOLDER app for a "bring your own code" project.
//
// This is a throwaway starter so your repo is GREEN on the very first CI build and deploy,
// BEFORE you write a line. Replace it (and the Dockerfile) with your own app in ANY language
// or framework — just keep the two platform contracts below and you stay green:
//
//  1. Listen on the port in the PORT env var (the platform sets it; default 8080).
//  2. Answer GET /healthz with HTTP 200, INDEPENDENT of any database (the liveness /
//     readiness probes hit it, so the pod stays Ready even before a database is provisioned).
//
// Everything under "/" is yours to replace. See README.md.
package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
)

// The friendly "replace me" landing page. Swap this out for your real app.
const replaceMe = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${{ values.appName }}</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5}code{background:#f4f4f5;padding:.1rem .3rem;border-radius:.2rem}</style>
</head>
<body>
<h1>${{ values.appName }} is running &#9989;</h1>
<p>This is the placeholder for a <strong>bring-your-own-code</strong> project. Your repo is
green out of the box &mdash; now replace this app with your own.</p>
<p>Edit <code>main.go</code> (or delete it and use any language) and the <code>Dockerfile</code>.
Keep <code>GET /healthz</code> returning 200 and listen on <code>$PORT</code>. Do not touch
<code>.devops/</code>. See <code>README.md</code>.</p>
</body>
</html>
`

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	mux := http.NewServeMux()

	// Platform probe endpoint — MUST stay 200 and database-independent.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintln(w, "ok")
	})

	// Your app goes here — replace this handler.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, replaceMe)
	})

	addr := ":" + port
	log.Printf("placeholder listening on %s (replace me — see README.md)", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
