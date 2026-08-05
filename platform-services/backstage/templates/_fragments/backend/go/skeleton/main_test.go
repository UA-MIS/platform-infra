// main_test.go — DB-independent tests proving the backend contract holds with NO database
// wired (a nil *sql.DB):
//   - /healthz returns 200 "ok"
//   - the data routes degrade to 503 (not a panic/500) when DATABASE_URL is unset
//   - the mysql:// -> driver DSN conversion is correct
package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRootReturnsOk(t *testing.T) {
	router := buildRouter(nil)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("root status = %d, want 200", w.Code)
	}
}

func TestHealthzIsOkAndDbIndependent(t *testing.T) {
	router := buildRouter(nil)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("healthz status = %d, want 200", w.Code)
	}
	if w.Body.String() != "ok" {
		t.Fatalf("healthz body = %q, want \"ok\"", w.Body.String())
	}
}

func TestItemsReturn503WhenDatabaseUrlUnset(t *testing.T) {
	router := buildRouter(nil)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/items", nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("/api/items status = %d, want 503", w.Code)
	}
}

func TestToDSN(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"mysql://u:p@dbhost:3306/mydb", "u:p@tcp(dbhost:3306)/mydb?parseTime=true"},
		{"mysql://u:p@dbhost/mydb", "u:p@tcp(dbhost:3306)/mydb?parseTime=true"},
	}
	for _, c := range cases {
		got, err := toDSN(c.in)
		if err != nil {
			t.Fatalf("toDSN(%q) error: %v", c.in, err)
		}
		if got != c.want {
			t.Fatalf("toDSN(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
