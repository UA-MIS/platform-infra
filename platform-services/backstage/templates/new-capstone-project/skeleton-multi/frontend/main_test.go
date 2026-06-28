package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestHealthz verifies the liveness/readiness endpoint always returns 200 OK.
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

// TestRootServesPage verifies "/" returns the HTML page that calls /api/hello.
func TestRootServesPage(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()

	rootHandler(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /: got status %d, want %d", rec.Code, http.StatusOK)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "/api/hello") {
		t.Errorf("GET /: page must call the backend at /api/hello, got %q", body)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("GET /: got Content-Type %q, want text/html", ct)
	}
}

// TestUnknownPath404 verifies a non-root path under the frontend returns 404
// (so the page isn't served for arbitrary paths).
func TestUnknownPath404(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/nope", nil)
	rec := httptest.NewRecorder()

	rootHandler(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Errorf("GET /nope: got status %d, want %d", rec.Code, http.StatusNotFound)
	}
}
