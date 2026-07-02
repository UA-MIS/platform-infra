<?php

namespace Tests\Feature;

use Tests\TestCase;

// Health + secret-proof endpoints (no database needed).
class HealthTest extends TestCase
{
    public function test_healthz_is_ok_and_db_independent(): void
    {
        $this->getJson('/healthz')->assertOk()->assertExactJson(['status' => 'ok']);
    }

    public function test_health_alias_is_ok(): void
    {
        $this->getJson('/health')->assertOk()->assertExactJson(['status' => 'ok']);
    }

    public function test_root_proves_secret_without_echoing_it(): void
    {
        putenv('APP_SECRET=hunter2');
        $_ENV['APP_SECRET'] = 'hunter2';
        $response = $this->getJson('/');
        $response->assertOk()
            ->assertJson(['secret_loaded' => true, 'secret_length' => 7]);
        $this->assertStringNotContainsString('hunter2', $response->getContent());
        putenv('APP_SECRET');
        unset($_ENV['APP_SECRET']);
    }

    public function test_root_reports_secret_missing_when_unset(): void
    {
        putenv('APP_SECRET');
        unset($_ENV['APP_SECRET']);
        $this->getJson('/')
            ->assertOk()
            ->assertJson(['secret_loaded' => false, 'secret_length' => 0]);
    }

    public function test_data_routes_degrade_to_503_when_db_unconfigured(): void
    {
        // Mirror the production "DATABASE_URL unset" path: default = mysql, no url. No
        // RefreshDatabase here, so nothing tries to connect to that (absent) MySQL — the
        // controller's guard returns 503 before touching the DB.
        config(['database.default' => 'mysql', 'database.connections.mysql.url' => null]);
        $this->getJson('/api/items')
            ->assertStatus(503)
            ->assertJson(['error' => 'database unavailable: DATABASE_URL is not set or the database is unreachable']);
    }
}
