#!/usr/bin/env python3
"""boot_probe.py — the RUNTIME half of the green-out-of-box gate (GATE-1).

Every existing green-check.py stage is STATIC: build-file exists, kustomize renders,
optionally `docker build` succeeds. None of them actually RUNS the built image. That gap let
backend/fastapi pass every existing gate while being unable to BOOT against the platform's
own MySQL DSN (F-6, FIX-8-REVIEW's DSN-001/DSN-003): SQLAlchemy resolves its DBAPI driver
EAGERLY at `create_engine()` call time, a bare `mysql://` scheme defaults to a driver that
isn't installed (MySQLdb, when only PyMySQL ships), and the pod crash-loops the instant a
real credential lands — invisible to every prior check, only caught by devops-fragments
actually running it.

This module builds each needsDB component's image (reusing the compose_lib-composed,
ALREADY-RENDERED skeleton — no Jinja/nunjucks templating happens here, that already
happened in compose_lib.compose()) and RUNS it against a REAL, disposable MariaDB
container, wired with a DATABASE_URL in EXACTLY the shape the platform's own contract
emits — see _contract/.devops/chart/overlays/dev/database.externalsecret.yaml:56:

    DATABASE_URL: "${{ dbScheme }}://{{ .username }}:{{ .password }}@{{ .host }}:{{ .port }}/..."

i.e. a BARE `mysql://user:pass@host:port/db` — no `+driver` decoration, no query string.
That fidelity is the entire point of this stage: a fragment that normalizes some OTHER DSN
shape but not this exact one would still pass a less faithful test and still crash-loop for
real students.

Then it probes GET /healthz on the SAME schedule as the chart's REAL startupProbe (see
_contract/.devops/chart/base/deployments.yaml:143-148: periodSeconds 2, failureThreshold 30
-> 60s total budget) — a fragment that would fail the actual chart's startup gate must fail
here too, and one that would pass must not be penalized by a tighter budget than production
allows.

ONE MariaDB container is shared across an entire sweep (started once by the caller via
MariaDBFixture.start(), reused per-fragment via make_database()) — spinning up a fresh
SERVER per fragment would multiply an already-heavy stage by fragment count for no benefit;
each fragment gets a fresh database + user (GRANT), not a fresh server.

Needs a working `docker` (or podman-as-docker) daemon — this is heavier than every other
green-check stage and is OFF BY DEFAULT (green-check.py --boot-probe), the same convention
as --docker-build. GitHub-hosted `ubuntu-latest` runners ship Docker; the self-hosted ARC
runners this platform otherwise uses for tenant builds do NOT (containerMode:kubernetes,
Kaniko-rootless, by design — no docker socket) — this stage MUST stay on a
Docker-capable runner. See wizard-green-check.yaml's boot-and-probe job.
"""
import shutil
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field

# Mirrors the chart's REAL startupProbe budget exactly (see module docstring).
PROBE_PERIOD_SECONDS = 2
PROBE_FAILURE_THRESHOLD = 30  # -> 60s total budget

# The platform's production DB tier engine version (phase-4 build kit: "DB tier
# PG17+MariaDB11.8") — same major.minor keeps driver/SQL-mode behavior representative
# rather than testing against whatever `:latest` happens to be today.
MARIADB_IMAGE = "mariadb:11.8"

BUILD_TIMEOUT_SECONDS = 300
CONTAINER_START_TIMEOUT_SECONDS = 30
MARIADB_READY_TIMEOUT_SECONDS = 60

DOCKER_CMD = shutil.which("docker") or shutil.which("podman")


class BootProbeError(Exception):
    """An ENVIRONMENT problem (docker missing, MariaDB fixture itself failed to come up) —
    distinct from a fragment-level finding (build failure, crash-loop, probe timeout), which
    boot_probe_component() reports as (False, detail) instead of raising."""


def _run(cmd, *, timeout, check=True):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if check and r.returncode != 0:
        raise BootProbeError(f"{' '.join(cmd)} failed (exit {r.returncode}): {r.stderr.strip()[:600]}")
    return r


@dataclass
class MariaDBFixture:
    """A disposable MariaDB container + a dedicated docker/podman network, meant to be
    started ONCE and shared across an entire green-check sweep. Context-manager friendly;
    always tears down its container + network, even on a failed start."""
    network: str
    container: str
    root_password: str = field(default="gate1-root-pw", repr=False)

    @classmethod
    def start(cls):
        if DOCKER_CMD is None:
            raise BootProbeError(
                "neither `docker` nor `podman` found on PATH — --boot-probe needs a working "
                "container runtime (see module docstring: this stage cannot run on the "
                "self-hosted ARC runners, which have none by design)"
            )
        suffix = uuid.uuid4().hex[:8]
        network = f"gate1-net-{suffix}"
        container = f"gate1-mariadb-{suffix}"
        _run([DOCKER_CMD, "network", "create", network], timeout=30)
        try:
            _run([
                DOCKER_CMD, "run", "-d", "--name", container, "--network", network,
                "-e", "MYSQL_ROOT_PASSWORD=gate1-root-pw",
                MARIADB_IMAGE,
            ], timeout=BUILD_TIMEOUT_SECONDS)  # generous: covers a cold image pull
        except BootProbeError:
            subprocess.run([DOCKER_CMD, "network", "rm", network], capture_output=True, timeout=30)
            raise
        fixture = cls(network=network, container=container)
        try:
            fixture._wait_ready()
        except Exception:
            fixture.stop()
            raise
        return fixture

    def _wait_ready(self):
        attempts = MARIADB_READY_TIMEOUT_SECONDS // 2
        for _ in range(attempts):
            r = subprocess.run(
                [DOCKER_CMD, "exec", self.container, "mariadb-admin", "ping",
                 "-uroot", f"-p{self.root_password}", "--silent"],
                capture_output=True, text=True, timeout=10,
            )
            if r.returncode == 0:
                return
            time.sleep(2)
        raise BootProbeError(
            f"MariaDB fixture {self.container} did not become ready within "
            f"{MARIADB_READY_TIMEOUT_SECONDS}s"
        )

    def make_database(self, dbname, user, password):
        """Create a fresh database + user + grant for ONE fragment's probe. Cheap (a few SQL
        statements against the already-running shared server) — this is what makes sharing
        one MariaDB container across the whole sweep safe: each fragment gets its own
        database/user, never a shared one."""
        sql = (
            f"CREATE DATABASE IF NOT EXISTS `{dbname}`; "
            f"CREATE USER IF NOT EXISTS '{user}'@'%' IDENTIFIED BY '{password}'; "
            f"GRANT ALL PRIVILEGES ON `{dbname}`.* TO '{user}'@'%'; FLUSH PRIVILEGES;"
        )
        _run([DOCKER_CMD, "exec", self.container, "mariadb", "-uroot",
              f"-p{self.root_password}", "-e", sql], timeout=20)

    def stop(self):
        subprocess.run([DOCKER_CMD, "rm", "-f", self.container], capture_output=True, timeout=30)
        subprocess.run([DOCKER_CMD, "network", "rm", self.network], capture_output=True, timeout=30)

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        self.stop()


def boot_probe_component(comp, out, mariadb):
    """Build (unless comp already declares buildType mobile-artifact — caller's job to
    filter those out) and RUN one composed component's image against `mariadb`, with a bare
    mysql:// DATABASE_URL in the platform's exact shape, and probe /healthz on the chart's
    real startupProbe schedule.

    Returns (ok: bool, detail: str). Deliberately never raises for a FRAGMENT-level failure
    (build error, crash-loop, probe timeout) — those are findings the caller should surface
    as a failed check, not harness errors. Only BootProbeError (environment problems)
    propagates.
    """
    if DOCKER_CMD is None:
        raise BootProbeError("docker/podman not found")

    ctx = out / comp["context"]
    dockerfile = ctx / (comp.get("dockerfile") or "Dockerfile")
    suffix = uuid.uuid4().hex[:8]

    build = subprocess.run([DOCKER_CMD, "build", "-q", "-f", str(dockerfile), str(ctx)],
                            capture_output=True, text=True, timeout=BUILD_TIMEOUT_SECONDS)
    if build.returncode != 0:
        return False, f"image build failed: {build.stderr.strip()[:600]}"
    image_id = build.stdout.strip().splitlines()[-1]

    dbname = f"gate1_{suffix}"
    dbuser = f"u{suffix}"
    dbpass = f"p{suffix}gate1"
    try:
        mariadb.make_database(dbname, dbuser, dbpass)
    except BootProbeError as e:
        raise BootProbeError(f"could not provision a test database on the shared MariaDB "
                              f"fixture: {e}") from e

    # THE fidelity point (see module docstring): bare scheme, no driver decoration, no
    # query string — exactly database.externalsecret.yaml:56's output shape.
    database_url = f"mysql://{dbuser}:{dbpass}@{mariadb.container}:3306/{dbname}"

    container = f"gate1-app-{suffix}"
    port = comp.get("port") or 8080
    try:
        run = subprocess.run([
            DOCKER_CMD, "run", "-d", "--name", container, "--network", mariadb.network,
            "-p", f"127.0.0.1::{port}",
            # The chart's REAL contract (readOnlyRootFilesystem: true + the two emptyDir
            # mounts it grants) — see _contract/.devops/chart/base/deployments.yaml and the
            # module docstring. This is the entire point of GATE-1: a writable-rootfs run
            # passes react-static and every other nginx-based fragment, then crash-loops
            # in-cluster (FINDING-6). Omitting these flags reproduces exactly that blind spot.
            "--read-only", "--tmpfs", "/tmp", "--tmpfs", "/dev/shm:size=64m",
            "-e", f"PORT={port}", "-e", f"DATABASE_URL={database_url}",
            image_id,
        ], capture_output=True, text=True, timeout=CONTAINER_START_TIMEOUT_SECONDS)
        if run.returncode != 0:
            return False, f"container failed to start: {run.stderr.strip()[:600]}"

        return _probe_healthz(container, port)
    finally:
        subprocess.run([DOCKER_CMD, "rm", "-f", container], capture_output=True, timeout=30)


def _probe_healthz(container, port, *, attempts=PROBE_FAILURE_THRESHOLD,
                    interval=PROBE_PERIOD_SECONDS):
    """Poll GET http://127.0.0.1:<host-mapped-port>/healthz, on the SAME schedule as the
    chart's real startupProbe. The container's STATUS is checked FIRST every iteration
    (catches a crash-on-start fast, rather than waiting out the full budget on a pod that is
    never coming back) — the published host port is only looked up AFTER confirming the
    container is still alive, because a container that crashed between `docker run -d`
    returning and the first `docker port` call would otherwise produce a confusing "port not
    found" error that masks the real crash (this raced in practice during development)."""
    last_err = "no attempts made"
    for i in range(attempts):
        insp = subprocess.run([DOCKER_CMD, "inspect", "-f", "{{.State.Status}}", container],
                               capture_output=True, text=True, timeout=10)
        status = insp.stdout.strip()
        if status not in ("running", "created"):
            return False, f"container exited (status={status}) before healthy\n{_tail_logs(container)}"

        port_lookup = subprocess.run([DOCKER_CMD, "port", container, str(port)],
                                      capture_output=True, text=True, timeout=10)
        if port_lookup.returncode != 0 or not port_lookup.stdout.strip():
            # Not published YET (Docker/podman can lag a moment behind State.Status=running)
            # — retry within the budget rather than failing immediately.
            last_err = "published port not yet available"
            time.sleep(interval)
            continue
        host_port = port_lookup.stdout.strip().splitlines()[0].rsplit(":", 1)[-1]

        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{host_port}/healthz",
                                        timeout=interval) as resp:
                if 200 <= resp.status < 300:
                    return True, f"healthy after {i + 1} attempt(s) (~{(i + 1) * interval}s)"
                last_err = f"HTTP {resp.status}"
        except (urllib.error.URLError, ConnectionError, OSError) as e:
            last_err = str(e)
        time.sleep(interval)
    return False, (
        f"/healthz never returned 2xx within {attempts * interval}s "
        f"(chart startupProbe budget: periodSeconds={interval} x failureThreshold={attempts}) "
        f"— last error: {last_err}\n{_tail_logs(container)}"
    )


def _tail_logs(container, lines=40):
    logs = subprocess.run([DOCKER_CMD, "logs", "--tail", str(lines), container],
                           capture_output=True, text=True, timeout=10)
    tail = (logs.stdout[-2000:] + logs.stderr[-500:]).strip()
    return f"container logs (tail):\n{tail}" if tail else "container logs: (empty)"
