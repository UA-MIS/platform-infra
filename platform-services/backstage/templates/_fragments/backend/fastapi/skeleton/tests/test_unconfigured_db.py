"""The no-database contract: data routes 503, health routes stay 200.

Every backend starter in the fragment library must degrade this way when
DATABASE_URL is unset (see _fragments/README.md); backend/express is the reference
implementation. This fragment used to fall back to an in-memory SQLite database
instead, which accepted writes (POST /api/items -> 201) into a database that lived
inside one container's memory: correct-looking at one replica in dev, silently lossy
at two or three, and wiped by every restart.

These tests import the app in a SEPARATE interpreter with the environment cleared,
because app/db.py resolves DATABASE_URL once at import time and the rest of the suite
runs with the in-memory opt-in switched on by conftest.py. Re-importing in-process
would leave `Depends(get_db)` in the already-imported router bound to the old module.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parent.parent

# Probe the real ASGI app through TestClient, with neither DATABASE_URL nor the
# in-memory opt-in set — i.e. exactly a freshly scaffolded repo with nothing in Vault.
_PROBE = """
import json, sys
sys.path.insert(0, {root!r})
from fastapi.testclient import TestClient
from app.main import app

out = {{}}
with TestClient(app) as c:
    out["healthz"] = c.get("/healthz").status_code
    out["health"] = c.get("/health").status_code
    out["root"] = c.get("/").status_code
    r = c.get("/api/items");           out["list"] = r.status_code; out["list_body"] = r.text
    r = c.post("/api/items", json={{"name": "student-data"}})
    out["create"] = r.status_code;     out["create_body"] = r.text
    out["get_one"] = c.get("/api/items/1").status_code
    out["update"] = c.put("/api/items/1", json={{"name": "x"}}).status_code
    out["delete"] = c.delete("/api/items/1").status_code
print("RESULT" + json.dumps(out))
"""


@pytest.fixture(scope="module")
def unconfigured():
    # Inherit the real environment (so the interpreter still finds its packages) and
    # remove ONLY the two variables under test — which is also what a freshly
    # scaffolded pod looks like: a normal environment that happens to have no
    # DATABASE_URL in it.
    env = dict(os.environ)
    env.pop("DATABASE_URL", None)
    env.pop("FASTAPI_ALLOW_MEMORY_DB", None)
    proc = subprocess.run(
        [sys.executable, "-c", _PROBE.format(root=str(_ROOT))],
        cwd=str(_ROOT), env=env, capture_output=True, text=True, check=False,
    )
    assert proc.returncode == 0, (
        "the app must still IMPORT and BOOT with no DATABASE_URL — a crash here is "
        f"the CrashLoopBackOff we are avoiding.\nstdout:\n{proc.stdout}\n"
        f"stderr:\n{proc.stderr}"
    )
    line = next(ln for ln in proc.stdout.splitlines() if ln.startswith("RESULT"))
    return json.loads(line[len("RESULT"):])


def test_healthz_stays_200_without_a_database(unconfigured):
    # The chart's readiness, liveness AND startup probes all hit /healthz. If this
    # went non-2xx, a student with no database would get a pod that never starts
    # instead of an app that tells them what is missing.
    assert unconfigured["healthz"] == 200
    assert unconfigured["health"] == 200


def test_root_stays_200_without_a_database(unconfigured):
    # / only reports on APP_SECRET; it takes no database dependency.
    assert unconfigured["root"] == 200


@pytest.mark.parametrize("route", ["list", "get_one", "update", "delete"])
def test_read_routes_503_without_a_database(unconfigured, route):
    assert unconfigured[route] == 503


def test_write_is_refused_not_silently_accepted(unconfigured):
    # THE regression. This used to return 201 and write into per-pod memory.
    assert unconfigured["create"] == 503


def test_503_body_names_the_missing_variable_and_where_to_set_it(unconfigured):
    for body in (unconfigured["list_body"], unconfigured["create_body"]):
        assert "DATABASE_URL" in body
        assert "Secrets" in body
