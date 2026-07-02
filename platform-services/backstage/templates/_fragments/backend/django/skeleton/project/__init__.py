# Install PyMySQL as the MySQLdb driver BEFORE Django imports its MySQL backend, so
# the pure-Python PyMySQL satisfies `django.db.backends.mysql` (no mysqlclient/apt).
try:
    import pymysql

    pymysql.install_as_MySQLdb()
except ImportError:  # pragma: no cover - pymysql is a runtime dependency
    pass
