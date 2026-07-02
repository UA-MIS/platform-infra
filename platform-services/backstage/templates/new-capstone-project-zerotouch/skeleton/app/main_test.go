package main

import (
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

// TestRootSecretLoaded verifies the root handler proves a secret read without
// echoing the value.
func TestRootSecretLoaded(t *testing.T) {
	t.Setenv("APP_SECRET", "hunter2")

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()

	rootHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /: got status %d, want %d", rec.Code, http.StatusOK)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "secret loaded: true") {
		t.Errorf("GET /: expected proof of loaded secret, got %q", body)
	}
	if strings.Contains(body, "hunter2") {
		t.Errorf("GET /: secret value LEAKED in response body: %q", body)
	}
}

// TestRootSecretMissing verifies the no-secret path reports loaded=false.
func TestRootSecretMissing(t *testing.T) {
	os.Unsetenv("APP_SECRET")

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()

	rootHandler(rec, req)

	if body := rec.Body.String(); !strings.Contains(body, "secret loaded: false") {
		t.Errorf("GET /: expected loaded=false with no secret, got %q", body)
	}
}
