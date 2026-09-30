FROM python:3.12-slim
WORKDIR /app
# NOTE: the build context is appliances/gb10 (the PARENT of this
# directory), not ./keyportal -- see docker-compose.yml. That is what lets
# the COPY of onboarding/ below reach outside keyportal/, and it is why
# every path here is prefixed with keyportal/.
COPY keyportal/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY keyportal/app.py .
# The onboarding setup scripts, served by GET /setup/macos-linux and
# /setup/windows with the signed-in student's own key substituted into one
# line (see _resolve_onboarding_dir() in app.py for why they are baked in
# at build time and read once at import, rather than re-read per request).
#
# These are the SAME BYTES the five gb10-onboarding-* CI jobs execute and
# the two 250+ assertion suites cover. Copying them in, rather than
# reimplementing them inside app.py, is the whole point: a second copy
# would drift from the tested one, which already happened once to this
# file's own Continue config block.
#
# app.py refuses to START if a script is missing or if its substitution
# marker line has drifted, so a broken image restart-loops with a named
# error in `docker compose logs keyportal` instead of 500-ing on a
# student's download at 9am in the first lab.
COPY onboarding/setup-macos-linux.sh onboarding/setup-windows.ps1 ./onboarding/
RUN mkdir -p /data
EXPOSE 8080
# Do NOT add --workers (or otherwise run more than one uvicorn process
# for this app, e.g. via gunicorn -w N or multiple replicas) without
# first reading app.py's _lock_for_email() docstring and B1's postmortem
# (security review, 2026-09-30). revoke_and_reissue()'s protection
# against orphaning an active key during a concurrent /regenerate
# additionally relies on a compare-and-swap write in issue_key() that IS
# safe across processes -- but the per-email in-process lock that avoids
# wasted LiteLLM calls on the losing side of a race is NOT, and depends
# on this staying a single process.
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
