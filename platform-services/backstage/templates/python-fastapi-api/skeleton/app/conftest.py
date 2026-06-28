"""pytest bootstrap for the FastAPI starter.

Two jobs:

1. Put THIS dir (the build context / package root) on sys.path so `import app...`
   resolves both locally and in CI (`cd app && pytest -q`).

2. Ensure the app's runtime + test dependencies are importable. The platform CI's
   Python checks step installs only `pytest` + `ruff`, not requirements.txt — so if a
   key import is missing we pip-install requirements-dev.txt (which pulls in
   requirements.txt). Local dev with deps already installed is a no-op. Test deps are
   kept in requirements-dev.txt so the runtime image (requirements.txt) stays lean.
"""

import importlib.util
import subprocess
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))


def _ensure_deps() -> None:
    if importlib.util.find_spec("fastapi") and importlib.util.find_spec("httpx"):
        return
    req = _HERE / "requirements-dev.txt"
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--quiet",
         "--root-user-action=ignore", "-r", str(req)],
        check=True,
    )


_ensure_deps()

import pytest  # noqa: E402  (imported after _ensure_deps so the bootstrap runs first)


@pytest.fixture(autouse=True)
def _reset_db():
    """Give each test a clean schema on the shared in-memory SQLite engine."""
    import app.models  # noqa: F401  (registers Item on Base.metadata)
    from app.db import Base, engine

    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    yield


@pytest.fixture()
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    # `with` runs the lifespan (startup init_db) and shutdown.
    with TestClient(app) as c:
        yield c
