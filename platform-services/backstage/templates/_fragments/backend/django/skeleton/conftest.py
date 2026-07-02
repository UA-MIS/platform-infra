"""pytest bootstrap for the Django starter.

Two jobs:

1. Put THIS dir (the build context / package root) on sys.path so `import project...`
   and `import items...` resolve in CI. The test DB is in-memory SQLite, configured by
   project.settings_test (pytest.ini's DJANGO_SETTINGS_MODULE) — no MySQL needed. The
   503-degrade test flips to the dummy backend with @override_settings.

2. Ensure the app's runtime + test dependencies are importable. The platform CI's
   Python checks step installs only pytest + ruff, not requirements.txt — so if a key
   import is missing we pip-install requirements-dev.txt (which pulls requirements.txt).
"""

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "project.settings_test")


def _ensure_deps() -> None:
    if importlib.util.find_spec("django") and importlib.util.find_spec("rest_framework"):
        return
    req = _HERE / "requirements-dev.txt"
    subprocess.run(
        [sys.executable, "-m", "pip", "install", "--quiet",
         "--root-user-action=ignore", "-r", str(req)],
        check=True,
    )


_ensure_deps()
