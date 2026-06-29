#!/usr/bin/env python
"""Django's command-line utility (manage.py migrate / test / runserver / ...)."""
import os
import sys


def main():
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "project.settings")
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:  # pragma: no cover
        raise ImportError(
            "Couldn't import Django. Are the dependencies installed and the "
            "virtualenv active?"
        ) from exc
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
