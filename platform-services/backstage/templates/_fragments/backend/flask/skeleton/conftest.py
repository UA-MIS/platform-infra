"""pytest bootstrap for the Flask starter.

Two jobs:

1. Put THIS dir (the build context / package root) on sys.path so `import app...`
   resolves both locally and in CI.

2. Ensure the app's runtime + test dependencies are importable. The platform CI's Python
   checks step installs only `pytest` + `ruff`, not requirements.txt — so if a key import
   is missing we pip-install requirements-dev.txt (which pulls in requirements.txt). Local
   dev with deps already installed is a no-op. Test deps live in requirements-dev.txt so
   the runtime image (requirements.txt) stays lean.
"""

import importlib.util
import subprocess
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))


def _ensure_deps() -> None:
    if importlib.util.find_spec("flask") and importlib.util.find_spec("sqlalchemy"):
        return
    req = _HERE / "requirements-dev.txt"
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--quiet",
         "--root-user-action=ignore", "-r", str(req)],
        check=True,
    )


_ensure_deps()

import pytest  # noqa: E402  (imported after _ensure_deps so the bootstrap runs first)


@pytest.fixture()
def client(monkeypatch):
    # The starter's contract tests run WITHOUT a database: /healthz must stay green and the
    # data routes must degrade to a clean 503. Ensure DATABASE_URL is unset for the test app.
    monkeypatch.delenv("DATABASE_URL", raising=False)
    # Reset the cached engine so the unset env takes effect for this app instance.
    import app.db as db

    db._engine = None

    from app import create_app

    app_obj = create_app()
    app_obj.config.update(TESTING=True)
    with app_obj.test_client() as c:
        yield c
