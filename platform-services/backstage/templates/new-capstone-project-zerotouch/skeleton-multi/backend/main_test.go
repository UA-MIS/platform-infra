package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// TestHealthz verifies the liveness/readiness endpoint always returns 200 OK
// regardless of secret state — probes must not depend on app config.
func TestHealthz(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	healthzHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /healthz: got status %d, want %d", rec.Code, http.StatusOK)
	}
	if body := strings.TrimSpace(rec.Body.String()); body != "ok" {
		t.Errorf("GET /healthz: got body %q, want %q", body, "ok")
	}
}

// TestHelloSecretLoaded verifies the API proves a secret read without echoing it.
func TestHelloSecretLoaded(t *testing.T) {
	t.Setenv("APP_SECRET", "hunter2")

	req := httptest.NewRequest(http.MethodGet, "/api/hello", nil)
	rec := httptest.NewRecorder()

	helloHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/hello: got status %d, want %d", rec.Code, http.StatusOK)
	}
	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("GET /api/hello: response is not valid JSON: %v", err)
	}
	if got["secretLoaded"] != true {
		t.Errorf("GET /api/hello: expected secretLoaded=true, got %v", got["secretLoaded"])
	}
	if strings.Contains(rec.Body.String(), "hunter2") {
		t.Errorf("GET /api/hello: secret value LEAKED in response body: %q", rec.Body.String())
	}
}

// TestHelloSecretMissing verifies the no-secret path reports secretLoaded=false.
func TestHelloSecretMissing(t *testing.T) {
	os.Unsetenv("APP_SECRET")

	req := httptest.NewRequest(http.MethodGet, "/api/hello", nil)
	rec := httptest.NewRecorder()

	helloHandler(rec, req)

	var got map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("GET /api/hello: response is not valid JSON: %v", err)
	}
	if got["secretLoaded"] != false {
		t.Errorf("GET /api/hello: expected secretLoaded=false with no secret, got %v", got["secretLoaded"])
	}
}
