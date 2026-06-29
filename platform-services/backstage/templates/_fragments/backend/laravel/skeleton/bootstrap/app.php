<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Support\Facades\Route;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        // The sample API. withRouting(api:) registers these routes under the /api prefix,
        // so the platform ingress (/api -> this backend) reaches them: /api/items.
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        // Root-level routes registered with NO middleware group (no session/cookie/CSRF),
        // so they need no APP_KEY and write nothing to disk (read-only-fs friendly).
        //   GET /healthz, /health : DB-independent 200 probe (the platform probes hit this).
        //   GET /                 : proves APP_SECRET was read without echoing it.
        then: function (): void {
            Route::get('/healthz', fn () => response()->json(['status' => 'ok']));
            Route::get('/health', fn () => response()->json(['status' => 'ok']));
            Route::get('/', [\App\Http\Controllers\RootController::class, 'index']);
        },
    )
    ->withMiddleware(function (Middleware $middleware): void {
        //
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        //
    })->create();
