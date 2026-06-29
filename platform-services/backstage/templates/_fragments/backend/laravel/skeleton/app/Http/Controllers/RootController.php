<?php

namespace App\Http\Controllers;

use Illuminate\Http\JsonResponse;

class RootController extends Controller
{
    /**
     * GET / — prove APP_SECRET was read WITHOUT leaking it: bool + length + sha256 prefix.
     *
     * APP_SECRET is wired by the platform from the ESO-materialized Secret
     * `${{ values.appName }}-secret` (optional — a fresh app still boots). Set it via the
     * Secrets tab in The Process.
     */
    public function index(): JsonResponse
    {
        $secret = (string) env('APP_SECRET', '');

        return response()->json([
            'app' => '${{ values.appName }}',
            'secret_loaded' => $secret !== '',
            'secret_length' => strlen($secret),
            'secret_sha256_prefix' => substr(hash('sha256', $secret), 0, 8),
        ]);
    }
}
