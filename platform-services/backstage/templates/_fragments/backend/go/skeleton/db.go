// db.go — the ONE place the database connection is built, from the DATABASE_URL env.
//
// DATABASE_URL is a standard mysql:// or postgres(ql):// URI (e.g.
// mysql://user:pass@host:3306/dbname or postgresql://user:pass@host:5432/dbname),
// supplied by the platform "Secrets" tab (External Secrets Operator + Vault -> a
// Kubernetes Secret env'd into the pod). The platform never rewrites this scheme
// (D-070, fragment-side only) — it emits whichever engine the wizard's database
// choice resolved to (FIX-16/D-092). Neither driver's DSN form matches the bare
// contract URI, so OpenDB detects the scheme and converts to the right one:
// go-sql-driver/mysql wants its own DSN form (user:pass@tcp(host:port)/db), while
// pgx's stdlib driver accepts a standard URL directly. NEVER hardcode credentials.
//
// database/sql itself has no notion of placeholder syntax or RETURNING — those differ
// per driver (`?` vs `$1`, no equivalent to LastInsertId() for Postgres) — so Driver
// is exported for items.go to branch its query text on.
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
	"strconv"
	"strings"

	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
)

// Driver identifies which SQL dialect items.go should speak: placeholder syntax,
// insert-id retrieval, and DDL type names all differ between the two.
type Driver string

const (
	DriverMySQL    Driver = "mysql"
	DriverPostgres Driver = "postgres"
)

// detectDriver inspects the DSN's scheme. The platform's DSN template emits the bare
// `postgresql://` form; a bring-your-own DATABASE_URL might use the shorter
// conventional `postgres://` — accept both.
func detectDriver(raw string) Driver {
	if strings.HasPrefix(raw, "postgres://") || strings.HasPrefix(raw, "postgresql://") {
		return DriverPostgres
	}
	return DriverMySQL
}

// OpenDB returns a *sql.DB and the Driver it speaks, or (nil, "") when DATABASE_URL is
// unset/invalid.
func OpenDB() (*sql.DB, Driver) {
	raw := os.Getenv("DATABASE_URL")
	if raw == "" {
		return nil, ""
	}
	driver := detectDriver(raw)

	var db *sql.DB
	var err error
	switch driver {
	case DriverPostgres:
		// pgx's stdlib driver accepts the contract's bare postgresql:// URL directly —
		// no DSN conversion needed, unlike go-sql-driver/mysql below.
		db, err = sql.Open("pgx", raw)
	default:
		dsn, dsnErr := toMysqlDSN(raw)
		if dsnErr != nil {
			log.Printf("invalid DATABASE_URL: %v", dsnErr)
			return nil, ""
		}
		db, err = sql.Open("mysql", dsn)
	}
	if err != nil {
		log.Printf("db open failed: %v", err)
		return nil, ""
	}
	// sql.Open is lazy (no connection yet), so a configured-but-unreachable DB does not
	// block startup. Best-effort schema bootstrap; ignore errors so boot never fails.
	if err := ensureSchema(db, driver); err != nil {
		log.Printf("schema bootstrap skipped: %v", err)
	}
	return db, driver
}

// toMysqlDSN converts a mysql:// URI to the go-sql-driver DSN
// (user:pass@tcp(host:port)/dbname?params), defaulting the port to 3306 and adding
// parseTime=true so DATETIME columns scan into time.Time.
func toMysqlDSN(raw string) (string, error) {
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

// ensureSchema idempotently creates the sample `items` table. MySQL's AUTO_INCREMENT
// has no direct Postgres spelling; SERIAL is the idiomatic equivalent. For real schema
// changes use a migration tool and remove this — see migrations/README.md.
func ensureSchema(db *sql.DB, driver Driver) error {
	if driver == DriverPostgres {
		_, err := db.Exec(
			"CREATE TABLE IF NOT EXISTS items (" +
				"id SERIAL PRIMARY KEY, " +
				"name VARCHAR(255) NOT NULL, " +
				"description VARCHAR(1024)" +
				")")
		return err
	}
	_, err := db.Exec(
		"CREATE TABLE IF NOT EXISTS items (" +
			"id INT AUTO_INCREMENT PRIMARY KEY, " +
			"name VARCHAR(255) NOT NULL, " +
			"description VARCHAR(1024)" +
			")")
	return err
}

// rebind rewrites a `?`-placeholder query (the form every call site in items.go is
// written in, matching go-sql-driver/mysql's native syntax) into Postgres's
// `$1, $2, ...` form. A no-op for MySQL. Centralizing this here (rather than writing
// two full copies of every query) keeps items.go readable while still giving each
// engine syntax it actually accepts.
func rebind(driver Driver, query string) string {
	if driver != DriverPostgres {
		return query
	}
	var b strings.Builder
	n := 0
	for _, r := range query {
		if r == '?' {
			n++
			b.WriteByte('$')
			b.WriteString(strconv.Itoa(n))
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}
