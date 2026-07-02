// db.go — the ONE place the MySQL connection is built, from the DATABASE_URL env.
//
// DATABASE_URL is a standard mysql:// URI (e.g. mysql://user:pass@host:3306/dbname),
// supplied by the platform "Secrets" tab (External Secrets Operator + Vault -> a
// Kubernetes Secret env'd into the pod). go-sql-driver/mysql does NOT accept a URI; it
// wants its own DSN form (user:pass@tcp(host:port)/db), so toDSN() converts it. NEVER
// hardcode credentials.
//
// Zero-config: if DATABASE_URL is UNSET, OpenDB returns nil so the data routes return a
// clear 503 — while /healthz stays green and the pod still becomes Ready on a fresh repo
// with nothing in Vault.
package main

import (
	"database/sql"
	"log"
	"net/url"
	"os"
	"strings"

	_ "github.com/go-sql-driver/mysql"
)

// OpenDB returns a *sql.DB built from DATABASE_URL, or nil when it is unset/invalid.
func OpenDB() *sql.DB {
	raw := os.Getenv("DATABASE_URL")
	if raw == "" {
		return nil
	}
	dsn, err := toDSN(raw)
	if err != nil {
		log.Printf("invalid DATABASE_URL: %v", err)
		return nil
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		log.Printf("db open failed: %v", err)
		return nil
	}
	// sql.Open is lazy (no connection yet), so a configured-but-unreachable DB does not
	// block startup. Best-effort schema bootstrap; ignore errors so boot never fails.
	if err := ensureSchema(db); err != nil {
		log.Printf("schema bootstrap skipped: %v", err)
	}
	return db
}

// toDSN converts a mysql:// URI to the go-sql-driver DSN
// (user:pass@tcp(host:port)/dbname?params), defaulting the port to 3306 and adding
// parseTime=true so DATETIME columns scan into time.Time.
func toDSN(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	host := u.Host
	if host == "" {
		host = "localhost:3306"
	} else if !strings.Contains(host, ":") {
		host += ":3306"
	}
	dbname := strings.TrimPrefix(u.Path, "/")

	user := ""
	if u.User != nil {
		user = u.User.Username()
		if pass, ok := u.User.Password(); ok {
			user += ":" + pass
		}
	}

	q := u.Query()
	if q.Get("parseTime") == "" {
		q.Set("parseTime", "true")
	}

	dsn := ""
	if user != "" {
		dsn = user + "@"
	}
	dsn += "tcp(" + host + ")/" + dbname
	if enc := q.Encode(); enc != "" {
		dsn += "?" + enc
	}
	return dsn, nil
}

// ensureSchema idempotently creates the sample `items` table. For real schema changes use
// a migration tool and remove this — see migrations/README.md.
func ensureSchema(db *sql.DB) error {
	_, err := db.Exec(
		"CREATE TABLE IF NOT EXISTS items (" +
			"id INT AUTO_INCREMENT PRIMARY KEY, " +
			"name VARCHAR(255) NOT NULL, " +
			"description VARCHAR(1024)" +
			")")
	return err
}
