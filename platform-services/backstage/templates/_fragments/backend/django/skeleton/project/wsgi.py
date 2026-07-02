# wsgi.py — the WSGI entrypoint gunicorn serves (gunicorn project.wsgi:application).
import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "project.settings")

application = get_wsgi_application()
