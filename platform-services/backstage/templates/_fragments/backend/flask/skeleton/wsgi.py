# wsgi.py — the WSGI entry point gunicorn imports (`wsgi:app`, see Dockerfile).
#
# It builds the Flask app via the application factory in app/__init__.py. Keeping the
# factory separate from this module makes the app easy to import in tests with a fresh
# instance per test session.
from app import create_app

app = create_app()
