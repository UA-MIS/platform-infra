# settings.py — ${{ values.appName }} (Django + DRF API starter).
#
# The ONE database knob is DATABASE_URL (a mysql:// URI), supplied by the platform
# Secrets tab (ESO -> Vault -> a Kubernetes Secret env'd into the pod), e.g.:
#
#     mysql://<user>:<password>@<host>:3306/<database>
#
# It is parsed by dj-database-url and served by PyMySQL (installed as MySQLdb in
# manage.py / wsgi.py), a pure-Python driver — so the image needs no compiler/apt.
# When DATABASE_URL is UNSET the app still boots, /healthz stays 200, and the data
# routes return a clear 503 (see items/views.py). NEVER hardcode credentials.
import os
from pathlib import Path

import dj_database_url

BASE_DIR = Path(__file__).resolve().parent.parent

# SECRET_KEY: read from the env; fall back to an ephemeral random value so the app
# boots zero-config. This is Django's signing key, NOT the app's APP_SECRET (which is
# surfaced separately at "/"). For stable signing set DJANGO_SECRET_KEY via the
# Secrets tab. NEVER hardcode a real secret here.
import secrets as _secrets  # noqa: E402

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY") or _secrets.token_urlsafe(50)

# DEBUG is OFF by default (production). Set DJANGO_DEBUG=1 only for local dev.
DEBUG = os.environ.get("DJANGO_DEBUG", "") == "1"

# Behind the platform ingress; host is validated at the edge. Allow all by default,
# overridable via DJANGO_ALLOWED_HOSTS (comma-separated).
ALLOWED_HOSTS = os.environ.get("DJANGO_ALLOWED_HOSTS", "*").split(",")

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.auth",
    "rest_framework",
    "items",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.middleware.common.CommonMiddleware",
]

ROOT_URLCONF = "project.urls"
WSGI_APPLICATION = "project.wsgi.application"

# DATABASE: parse DATABASE_URL when present; otherwise use the "dummy" backend so the
# process boots without a database (any query raises, which the views turn into a 503).
DATABASE_URL = os.environ.get("DATABASE_URL", "")
if DATABASE_URL:
    DATABASES = {"default": dj_database_url.parse(DATABASE_URL, conn_max_age=600)}
else:
    DATABASES = {"default": {"ENGINE": "django.db.backends.dummy"}}

# DRF: open the sample API (AllowAny) with no session/cookie auth — pure stateless JSON,
# so no CSRF/session middleware or writable storage is needed (read-only-fs friendly).
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.AllowAny"],
    # JSON only: drop the Browsable API so no templates/static are rendered.
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
}

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
USE_TZ = True

# Log to stdout only — the pod runs read-only-root with no writable filesystem, so the
# app must never write log files (the platform aggregates container stdout).
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": "INFO"},
}
