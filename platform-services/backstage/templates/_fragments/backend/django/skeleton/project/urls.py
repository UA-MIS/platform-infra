# urls.py — top-level routes.
#
#   GET /healthz : 200 {"status":"ok"} — DB-INDEPENDENT liveness/readiness probe. The
#                  platform chart's probes hit THIS path, so it must stay green with no
#                  database. Keep it cheap and dependency-free.
#   GET /        : 200 — proves APP_SECRET was read WITHOUT echoing it.
#   /api/...     : the sample API (see items/urls.py). Served under /api so the platform
#                  ingress (which routes /api -> this backend) reaches it.
import hashlib
import os

from django.http import JsonResponse
from django.urls import include, path


def healthz(_request):
    """Liveness/readiness — always 200 while the process is up; never touches the DB."""
    return JsonResponse({"status": "ok"})


def root(_request):
    """Prove APP_SECRET was read WITHOUT leaking it: bool + length + sha256 prefix.

    APP_SECRET is wired by the platform from the ESO-materialized Secret
    `${{ values.appName }}-secret` (optional — a fresh app still boots). Set it via the
    Secrets tab in The Process.
    """
    secret = os.environ.get("APP_SECRET", "")
    digest = hashlib.sha256(secret.encode()).hexdigest()[:8]
    return JsonResponse(
        {
            "app": "${{ values.appName }}",
            "secret_loaded": bool(secret),
            "secret_length": len(secret),
            "secret_sha256_prefix": digest,
        }
    )


urlpatterns = [
    path("healthz", healthz),
    path("health", healthz),
    path("", root),
    path("api/", include("items.urls")),
]
