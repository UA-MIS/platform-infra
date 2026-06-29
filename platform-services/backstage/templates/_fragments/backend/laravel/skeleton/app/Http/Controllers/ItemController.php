<?php

namespace App\Http\Controllers;

use App\Models\Item;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

// Sample CRUD over the Item model, mounted at /api/items. Copy this pattern for your
// own resources.
//
// Degrade rule (the backend contract): the data routes need a database. When DATABASE_URL
// is unset (no usable connection) or the DB is unreachable, they return a clear 503 — while
// /healthz (bootstrap/app.php) stays 200. NEVER hardcode credentials; the DSN comes only
// from the DATABASE_URL env (Secrets tab -> ESO -> Vault).
class ItemController extends Controller
{
    private const RULES = [
        'name' => ['required', 'string', 'max:255'],
        'description' => ['nullable', 'string', 'max:1024'],
    ];

    public function index(): JsonResponse
    {
        if ($resp = $this->guardDatabase()) {
            return $resp;
        }

        return $this->guard(fn () => response()->json(Item::orderBy('id')->get()));
    }

    public function store(Request $request): JsonResponse
    {
        if ($resp = $this->guardDatabase()) {
            return $resp;
        }
        $data = $request->validate(self::RULES);

        return $this->guard(fn () => response()->json(Item::create($data), 201));
    }

    public function show(string $id): JsonResponse
    {
        if ($resp = $this->guardDatabase()) {
            return $resp;
        }

        return $this->guard(function () use ($id) {
            $item = Item::find($id);

            return $item
                ? response()->json($item)
                : response()->json(['error' => 'item not found'], 404);
        });
    }

    public function update(Request $request, string $id): JsonResponse
    {
        if ($resp = $this->guardDatabase()) {
            return $resp;
        }
        $data = $request->validate([
            'name' => ['sometimes', 'string', 'max:255'],
            'description' => ['nullable', 'string', 'max:1024'],
        ]);

        return $this->guard(function () use ($id, $data) {
            $item = Item::find($id);
            if (! $item) {
                return response()->json(['error' => 'item not found'], 404);
            }
            $item->update($data);

            return response()->json($item);
        });
    }

    public function destroy(string $id): JsonResponse
    {
        if ($resp = $this->guardDatabase()) {
            return $resp;
        }

        return $this->guard(function () use ($id) {
            $item = Item::find($id);
            if (! $item) {
                return response()->json(['error' => 'item not found'], 404);
            }
            $item->delete();

            return response()->json(null, 204);
        });
    }

    /** 503 when the default connection is not usable (e.g. DATABASE_URL unset). */
    private function guardDatabase(): ?JsonResponse
    {
        $name = config('database.default');
        $conn = config("database.connections.$name", []);
        $configured = ($conn['driver'] ?? null) === 'sqlite'
            ? ! empty($conn['database'])      // tests use sqlite (:memory:)
            : ! empty($conn['url']);          // mysql/etc: wired ONLY via DATABASE_URL

        return $configured ? null : $this->unavailable();
    }

    /** Run a DB operation, turning a connection failure into a 503. */
    private function guard(callable $op): JsonResponse
    {
        try {
            return $op();
        } catch (QueryException) {
            return $this->unavailable();
        }
    }

    private function unavailable(): JsonResponse
    {
        return response()->json([
            'error' => 'database unavailable: DATABASE_URL is not set or the database is unreachable',
        ], 503);
    }
}
