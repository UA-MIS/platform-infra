// HealthController.java — the platform probe path + a human-facing API health view.
//
//   GET /healthz    -> 200 "ok", DB-INDEPENDENT (the chart's readiness/liveness probes
//                      hit this; it must stay green even with no DB).
//   GET /api/health -> 200 JSON: app name + whether the DB is configured/reachable.
package com.example.app;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class HealthController {

    private final Db db;

    public HealthController(Db db) {
        this.db = db;
    }

    @GetMapping(value = "/healthz", produces = MediaType.TEXT_PLAIN_VALUE)
    public ResponseEntity<String> healthz() {
        return ResponseEntity.ok("ok");
    }

    // Root — so a student's first visit to the app's own URL isn't a 404. API-only
    // backend: no UI lives here (a fullstack layout's frontend owns "/" instead).
    @GetMapping(value = "/", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> root() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("service", "${{ values.appName }}");
        body.put("status", "running");
        body.put("hints", new String[] {"/healthz", "/api/health", "/api/items"});
        return body;
    }

    @GetMapping(value = "/api/health", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> apiHealth() {
        String dbStatus = "unconfigured";
        if (db.isConfigured()) {
            try {
                db.jdbc().queryForObject("SELECT 1", Integer.class);
                dbStatus = "up";
            } catch (RuntimeException e) {
                dbStatus = "down";
            }
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "ok");
        body.put("app", "${{ values.appName }}");
        body.put("db", dbStatus);
        return body;
    }
}
