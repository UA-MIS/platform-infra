// ${{ values.appName }} — UA-MIS capstone Spring Boot (Java 21) API starter.
//
// Proves the golden path end to end: PR -> preview, merge -> dev, tag -> staging,
// manual gate -> prod. Ships:
//   GET /healthz     : 200 "ok" — liveness/readiness probe (the .devops chart probes THIS
//                      path; DB-independent so the pod is Ready even with no DB).
//   GET /api/health  : 200 JSON — app name + whether the DB is configured/reachable.
//   /api/items       : a sample JdbcTemplate CRUD over MySQL.
//
// Edit this freely — it is YOUR app code. (Do not edit .devops/.)
//
// DataSourceAutoConfiguration is EXCLUDED so the app boots with NO database wired (a
// freshly scaffolded repo has no DATABASE_URL yet). The optional MySQL connection is
// built at runtime in Db.java from the DATABASE_URL env. NEVER hardcode credentials.
package com.example.app;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration;

@SpringBootApplication(exclude = DataSourceAutoConfiguration.class)
public class Application {
    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }
}
