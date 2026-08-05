// HealthController.java — the platform probe path + a human-facing API health view.
//
//   GET /healthz    -> 200 "ok", DB-INDEPENDENT (the chart's readiness/liveness probes
//                      hit this; it must stay green even with no DB).
//   GET /api/health -> 200 JSON: app name + whether the DB is configured/reachable.
//   GET /           -> 200 JSON: proves APP_SECRET was read WITHOUT echoing it.
package com.example.app;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
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

    // Gives a single-component backend (no frontend) something other than a 404 at "/",
    // and proves APP_SECRET was read WITHOUT echoing it.
    @GetMapping(value = "/", produces = MediaType.APPLICATION_JSON_VALUE)
    public Map<String, Object> root() {
        String secret = System.getenv().getOrDefault("APP_SECRET", "");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("app", "${{ values.appName }}");
        body.put("secret_loaded", !secret.isEmpty());
        body.put("secret_length", secret.length());
        body.put("secret_sha256_prefix", sha256Prefix(secret));
        return body;
    }

    private static String sha256Prefix(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(hash).substring(0, 8);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }
}
