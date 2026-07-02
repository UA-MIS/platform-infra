// ItemController.java — a sample CRUD router over the `items` table (JdbcTemplate). This
// is the pattern to copy for your own resources. Every data route checks db.isConfigured()
// first and returns a clear 503 when DATABASE_URL is unset, so a freshly scaffolded app
// (no DB wired yet) degrades cleanly instead of throwing.
package com.example.app;

import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/items")
public class ItemController {

    private static final RowMapper<Item> ITEM_MAPPER =
        (rs, n) -> new Item(rs.getLong("id"), rs.getString("name"), rs.getString("description"));

    private final Db db;

    public ItemController(Db db) {
        this.db = db;
    }

    /** Sample-row input (the request body). */
    public record ItemInput(String name, String description) {}

    private ResponseEntity<Object> noDb() {
        return ResponseEntity.status(503).body(Map.of(
            "error",
            "DATABASE_URL is not set. Add it via The Process \"Secrets\" tab (key: DATABASE_URL)."));
    }

    @GetMapping
    public ResponseEntity<Object> list() {
        if (!db.isConfigured()) {
            return noDb();
        }
        List<Item> items = db.jdbc().query(
            "SELECT id, name, description FROM items ORDER BY id", ITEM_MAPPER);
        return ResponseEntity.ok(items);
    }

    @GetMapping("/{id}")
    public ResponseEntity<Object> get(@PathVariable long id) {
        if (!db.isConfigured()) {
            return noDb();
        }
        List<Item> rows = db.jdbc().query(
            "SELECT id, name, description FROM items WHERE id = ?", ITEM_MAPPER, id);
        if (rows.isEmpty()) {
            return ResponseEntity.status(404).body(Map.of("error", "not found"));
        }
        return ResponseEntity.ok(rows.get(0));
    }

    @PostMapping
    public ResponseEntity<Object> create(@RequestBody ItemInput input) {
        if (!db.isConfigured()) {
            return noDb();
        }
        String name = input.name() == null ? "" : input.name().trim();
        if (name.isEmpty()) {
            return ResponseEntity.status(400).body(Map.of("error", "name is required"));
        }
        KeyHolder keys = new GeneratedKeyHolder();
        db.jdbc().update(con -> {
            var ps = con.prepareStatement(
                "INSERT INTO items (name, description) VALUES (?, ?)",
                new String[] {"id"});
            ps.setString(1, name);
            ps.setString(2, input.description());
            return ps;
        }, keys);
        long id = keys.getKey() == null ? 0L : keys.getKey().longValue();
        return ResponseEntity.status(201).body(new Item(id, name, input.description()));
    }

    @PutMapping("/{id}")
    public ResponseEntity<Object> update(@PathVariable long id, @RequestBody ItemInput input) {
        if (!db.isConfigured()) {
            return noDb();
        }
        String name = input.name() == null ? "" : input.name().trim();
        if (name.isEmpty()) {
            return ResponseEntity.status(400).body(Map.of("error", "name is required"));
        }
        int rows = db.jdbc().update(
            "UPDATE items SET name = ?, description = ? WHERE id = ?",
            name, input.description(), id);
        if (rows == 0) {
            return ResponseEntity.status(404).body(Map.of("error", "not found"));
        }
        return ResponseEntity.ok(new Item(id, name, input.description()));
    }

    @DeleteMapping("/{id}")
    public ResponseEntity<Object> delete(@PathVariable long id) {
        if (!db.isConfigured()) {
            return noDb();
        }
        int rows = db.jdbc().update("DELETE FROM items WHERE id = ?", id);
        if (rows == 0) {
            return ResponseEntity.status(404).body(Map.of("error", "not found"));
        }
        return ResponseEntity.noContent().build();
    }
}
