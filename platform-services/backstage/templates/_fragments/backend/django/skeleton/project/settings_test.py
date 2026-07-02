# settings_test.py — test settings: inherit everything, but use an in-memory SQLite DB
# so the suite needs no MySQL. The 503-degrade test flips DATABASES to the dummy backend
# with @override_settings (see tests/test_items.py), exactly mirroring the production
# "DATABASE_URL unset" path.
from .settings import *  # noqa: F401,F403

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": ":memory:",
    }
}
