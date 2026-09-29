FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
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
