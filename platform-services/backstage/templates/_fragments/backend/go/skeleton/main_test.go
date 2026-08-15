// main_test.go — DB-independent tests proving the backend contract holds with NO database
// wired (a nil *sql.DB):
//   - /healthz returns 200 "ok"
//   - the data routes degrade to 503 (not a panic/500) when DATABASE_URL is unset
//   - the mysql:// -> driver DSN conversion is correct
//   - DATABASE_URL scheme detection (mysql vs postgres) and the `?` -> `$1` rebind used
//     for Postgres queries are correct (FIX-16/D-092)
package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRootReturnsOk(t *testing.T) {
	router := buildRouter(nil, "")
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("root status = %d, want 200", w.Code)
	}
}

func TestHealthzIsOkAndDbIndependent(t *testing.T) {
	router := buildRouter(nil, "")
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
	router := buildRouter(nil, "")
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/items", nil)
	router.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("/api/items status = %d, want 503", w.Code)
	}
}

func TestToMysqlDSN(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"mysql://u:p@dbhost:3306/mydb", "u:p@tcp(dbhost:3306)/mydb?parseTime=true"},
		{"mysql://u:p@dbhost/mydb", "u:p@tcp(dbhost:3306)/mydb?parseTime=true"},
	}
	for _, c := range cases {
		got, err := toMysqlDSN(c.in)
		if err != nil {
			t.Fatalf("toMysqlDSN(%q) error: %v", c.in, err)
		}
		if got != c.want {
			t.Fatalf("toMysqlDSN(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestDetectDriver(t *testing.T) {
	cases := []struct {
		in   string
		want Driver
	}{
		{"mysql://u:p@dbhost:3306/mydb", DriverMySQL},
		// The platform's DSN template emits exactly this bare scheme (dbScheme='postgresql').
		{"postgresql://u:p@dbhost:5432/mydb", DriverPostgres},
		// A bring-your-own DATABASE_URL might use the shorter conventional form.
		{"postgres://u:p@dbhost:5432/mydb", DriverPostgres},
	}
	for _, c := range cases {
		got := detectDriver(c.in)
		if got != c.want {
			t.Fatalf("detectDriver(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestRebindIsNoopForMysql(t *testing.T) {
	q := "SELECT id, name FROM items WHERE id = ? AND name = ?"
	got := rebind(DriverMySQL, q)
	if got != q {
		t.Fatalf("rebind(mysql, %q) = %q, want unchanged", q, got)
	}
}

func TestRebindNumbersPlaceholdersForPostgres(t *testing.T) {
	q := "UPDATE items SET name = ?, description = ? WHERE id = ?"
	want := "UPDATE items SET name = $1, description = $2 WHERE id = $3"
	got := rebind(DriverPostgres, q)
	if got != want {
		t.Fatalf("rebind(postgres, %q) = %q, want %q", q, got, want)
	}
}

func TestRebindNoPlaceholdersIsUnchanged(t *testing.T) {
	q := "SELECT id, name, description FROM items ORDER BY id"
	got := rebind(DriverPostgres, q)
	if got != q {
		t.Fatalf("rebind(postgres, %q) = %q, want unchanged", q, got)
	}
}
