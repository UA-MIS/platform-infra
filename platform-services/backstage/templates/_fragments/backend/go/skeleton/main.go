// ${{ values.appName }} — UA-MIS capstone Go (Gin) API starter.
//
// Proves the golden path end to end: PR -> preview, merge -> dev, tag -> staging,
// manual gate -> prod. Ships:
//
//	GET /healthz     : 200 "ok" — liveness/readiness probe (the .devops chart probes THIS
//	                   path; DB-independent so the pod is Ready even with no DB).
//	GET /api/health  : 200 JSON — app name + whether the DB is configured/reachable.
//	/api/items       : a sample database/sql CRUD over MySQL.
//
// Edit this freely — it is YOUR app code. (Do not edit .devops/.)
//
// The MySQL connection is built from the DATABASE_URL env (see db.go). A freshly
// scaffolded app has no DATABASE_URL and still starts cleanly: /healthz stays green and
// the data routes return a clear 503. NEVER hardcode credentials.
package main

import (
	"database/sql"
	"log"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"
)

// appName is the scaffolded project name, surfaced in /api/health.
const appName = "${{ values.appName }}"

func main() {
	db := OpenDB() // *sql.DB, or nil when DATABASE_URL is unset
	if db != nil {
		defer db.Close()
	}

	router := buildRouter(db)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	log.Printf("%s listening on :%s", appName, port)
	if err := router.Run(":" + port); err != nil {
		log.Fatal(err)
	}
}

// buildRouter wires every route. Kept separate from main() so tests can construct the
// router with a nil (or fake) DB.
func buildRouter(db *sql.DB) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	// Liveness/readiness probe — DB-INDEPENDENT (the chart hits this directly).
	r.GET("/healthz", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})

	// App-level health — reports whether the DB is configured and reachable.
	r.GET("/api/health", func(c *gin.Context) {
		dbStatus := "unconfigured"
		if db != nil {
			if err := db.Ping(); err != nil {
				dbStatus = "down"
			} else {
				dbStatus = "up"
			}
		}
		c.JSON(http.StatusOK, gin.H{"status": "ok", "app": appName, "db": dbStatus})
	})

	registerItemRoutes(r, db)
	return r
}
