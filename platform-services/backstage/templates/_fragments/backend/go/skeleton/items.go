// items.go — a sample CRUD router over the `items` table (database/sql). This is the
// pattern to copy for your own resources. Every data route checks for a configured DB
// first and returns a clear 503 when DATABASE_URL is unset, so a freshly scaffolded app
// (no DB wired yet) degrades cleanly instead of panicking.
//
// Every query is written against MySQL's `?` placeholder syntax and passed through
// rebind() (db.go), which rewrites it to Postgres's `$1, $2, ...` form when driver ==
// DriverPostgres — the one exception is INSERT, where the two engines have no shared
// insert-id mechanism at all: MySQL returns it via LastInsertId() on the Exec result;
// Postgres has no such wire-protocol feature, so the Postgres branch uses `RETURNING
// id` with QueryRow instead (FIX-16/D-092).
package main

import (
	"database/sql"
	"net/http"

	"github.com/gin-gonic/gin"
)

// Item is both the JSON wire shape and the row shape. Description is nullable.
type Item struct {
	ID          int64   `json:"id"`
	Name        string  `json:"name"`
	Description *string `json:"description,omitempty"`
}

type itemInput struct {
	Name        string  `json:"name"`
	Description *string `json:"description"`
}

func registerItemRoutes(r *gin.Engine, db *sql.DB, driver Driver) {
	// requireDB writes a 503 and returns false when no database is configured.
	requireDB := func(c *gin.Context) bool {
		if db == nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error": "DATABASE_URL is not set. Add it via The Process \"Secrets\" tab (key: DATABASE_URL).",
			})
			return false
		}
		return true
	}

	g := r.Group("/api/items")

	g.GET("", func(c *gin.Context) {
		if !requireDB(c) {
			return
		}
		rows, err := db.Query(rebind(driver, "SELECT id, name, description FROM items ORDER BY id"))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "query failed"})
			return
		}
		defer rows.Close()
		items := []Item{}
		for rows.Next() {
			var it Item
			if err := rows.Scan(&it.ID, &it.Name, &it.Description); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "scan failed"})
				return
			}
			items = append(items, it)
		}
		c.JSON(http.StatusOK, gin.H{"items": items})
	})

	g.GET("/:id", func(c *gin.Context) {
		if !requireDB(c) {
			return
		}
		var it Item
		err := db.QueryRow(rebind(driver, "SELECT id, name, description FROM items WHERE id = ?"), c.Param("id")).
			Scan(&it.ID, &it.Name, &it.Description)
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "query failed"})
			return
		}
		c.JSON(http.StatusOK, it)
	})

	g.POST("", func(c *gin.Context) {
		if !requireDB(c) {
			return
		}
		var in itemInput
		if err := c.ShouldBindJSON(&in); err != nil || in.Name == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
			return
		}
		if driver == DriverPostgres {
			// No LastInsertId() equivalent on the wire — RETURNING is the idiomatic
			// (and only reliable) way to get the generated id back in one round trip.
			var id int64
			err := db.QueryRow(
				"INSERT INTO items (name, description) VALUES ($1, $2) RETURNING id",
				in.Name, in.Description,
			).Scan(&id)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "insert failed"})
				return
			}
			c.JSON(http.StatusCreated, Item{ID: id, Name: in.Name, Description: in.Description})
			return
		}
		res, err := db.Exec("INSERT INTO items (name, description) VALUES (?, ?)", in.Name, in.Description)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "insert failed"})
			return
		}
		id, _ := res.LastInsertId()
		c.JSON(http.StatusCreated, Item{ID: id, Name: in.Name, Description: in.Description})
	})

	g.PUT("/:id", func(c *gin.Context) {
		if !requireDB(c) {
			return
		}
		var in itemInput
		if err := c.ShouldBindJSON(&in); err != nil || in.Name == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
			return
		}
		res, err := db.Exec(
			rebind(driver, "UPDATE items SET name = ?, description = ? WHERE id = ?"),
			in.Name, in.Description, c.Param("id"),
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "update failed"})
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"name": in.Name, "description": in.Description})
	})

	g.DELETE("/:id", func(c *gin.Context) {
		if !requireDB(c) {
			return
		}
		res, err := db.Exec(rebind(driver, "DELETE FROM items WHERE id = ?"), c.Param("id"))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "delete failed"})
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}
		c.Status(http.StatusNoContent)
	})
}
