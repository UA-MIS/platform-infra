// Db.java — the ONE place the MySQL connection is built, from the DATABASE_URL env.
//
// DATABASE_URL is a standard mysql:// URI (e.g. mysql://user:pass@host:3306/dbname),
// supplied by the platform "Secrets" tab (External Secrets Operator + Vault -> a
// Kubernetes Secret env'd into the pod). JDBC wants a jdbc:mysql:// URL plus the
// username/password split out, so toJdbcUrl()/init() parse the URI and configure
// HikariCP. NEVER hardcode credentials.
//
// Zero-config: if DATABASE_URL is UNSET the JdbcTemplate stays null, isConfigured()
// returns false, and the data routes return a clear 503 — while /healthz stays green so
// the pod still becomes Ready on a fresh repo with nothing in Vault. Hikari is configured
// with initializationFailTimeout=-1 so a configured-but-unreachable DB never blocks/crashes
// startup either (the first query simply fails and the route reports it).
package com.example.app;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import jakarta.annotation.PostConstruct;
import java.net.URI;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

@Component
public class Db {

    private JdbcTemplate jdbc; // null until/unless DATABASE_URL is set

    public boolean isConfigured() {
        return jdbc != null;
    }

    /** The JdbcTemplate, or null when DATABASE_URL is unset (callers must check first). */
    public JdbcTemplate jdbc() {
        return jdbc;
    }

    @PostConstruct
    void init() {
        String url = System.getenv("DATABASE_URL");
        if (url == null || url.isBlank()) {
            return; // zero-config: data routes will 503 until a DATABASE_URL secret is set
        }
        HikariDataSource ds = buildDataSource(url);
        this.jdbc = new JdbcTemplate(ds);
        try {
            ensureSchema();
        } catch (RuntimeException e) {
            // DB configured but not reachable yet — don't crash; the route will report it.
            System.err.println("schema bootstrap skipped: " + e.getMessage());
        }
    }

    /** Convert a mysql:// URI to the jdbc:mysql:// URL form (preserving any query string). */
    static String toJdbcUrl(String databaseUrl) {
        URI u = URI.create(databaseUrl);
        String host = u.getHost() == null ? "localhost" : u.getHost();
        int port = u.getPort() == -1 ? 3306 : u.getPort();
        String db = (u.getPath() == null) ? "" : u.getPath().replaceFirst("^/", "");
        String jdbcUrl = "jdbc:mysql://" + host + ":" + port + "/" + db;
        String query = u.getRawQuery();
        if (query != null && !query.isBlank()) {
            jdbcUrl += "?" + query;
        }
        return jdbcUrl;
    }

    private static HikariDataSource buildDataSource(String databaseUrl) {
        URI u = URI.create(databaseUrl);
        String user = null;
        String pass = null;
        String userInfo = u.getUserInfo();
        if (userInfo != null) {
            int idx = userInfo.indexOf(':');
            if (idx >= 0) {
                user = userInfo.substring(0, idx);
                pass = userInfo.substring(idx + 1);
            } else {
                user = userInfo;
            }
        }
        HikariConfig cfg = new HikariConfig();
        cfg.setJdbcUrl(toJdbcUrl(databaseUrl));
        if (user != null) {
            cfg.setUsername(user);
        }
        if (pass != null) {
            cfg.setPassword(pass);
        }
        cfg.setMaximumPoolSize(5);
        // Never block or fail container startup if the DB is not reachable yet.
        cfg.setInitializationFailTimeout(-1);
        return new HikariDataSource(cfg);
    }

    /** Idempotent sample-table bootstrap. For real schema changes use migrations
     *  (Flyway/Liquibase) instead — see migrations/README.md. No-op when unconfigured. */
    void ensureSchema() {
        if (jdbc == null) {
            return;
        }
        jdbc.execute(
            "CREATE TABLE IF NOT EXISTS items ("
                + "id BIGINT AUTO_INCREMENT PRIMARY KEY, "
                + "name VARCHAR(255) NOT NULL, "
                + "description VARCHAR(1024)"
                + ")");
    }
}
