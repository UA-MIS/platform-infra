<?php

use App\Http\Controllers\ItemController;
use Illuminate\Support\Facades\Route;

// These routes are registered under the /api prefix (see bootstrap/app.php withRouting),
// so the platform ingress (/api -> this backend) reaches them: /api/items, /api/items/{id}.
Route::apiResource('items', ItemController::class);
