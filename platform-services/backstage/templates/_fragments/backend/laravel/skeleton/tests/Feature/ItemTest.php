<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

// CRUD for the sample /api/items resource (SQLite test DB) + the DB-degrade (503) path.
class ItemTest extends TestCase
{
    use RefreshDatabase;

    public function test_create_and_get_item(): void
    {
        $created = $this->postJson('/api/items', ['name' => 'widget', 'description' => 'a thing']);
        $created->assertCreated()->assertJson(['name' => 'widget', 'description' => 'a thing']);
        $id = $created->json('id');
        $this->assertGreaterThan(0, $id);

        $this->getJson("/api/items/$id")->assertOk()->assertJson(['name' => 'widget']);
    }

    public function test_list_items(): void
    {
        $this->postJson('/api/items', ['name' => 'a']);
        $this->postJson('/api/items', ['name' => 'b']);
        $this->getJson('/api/items')->assertOk()->assertJsonCount(2);
    }

    public function test_update_item(): void
    {
        $id = $this->postJson('/api/items', ['name' => 'old'])->json('id');
        $this->putJson("/api/items/$id", ['name' => 'new'])->assertOk()->assertJson(['name' => 'new']);
    }

    public function test_delete_item(): void
    {
        $id = $this->postJson('/api/items', ['name' => 'doomed'])->json('id');
        $this->deleteJson("/api/items/$id")->assertNoContent();
        $this->getJson("/api/items/$id")->assertNotFound();
    }

    public function test_missing_item_is_404(): void
    {
        $this->getJson('/api/items/999999')->assertNotFound();
    }

    public function test_invalid_item_is_422(): void
    {
        $this->postJson('/api/items', ['name' => ''])->assertStatus(422);
    }
}
