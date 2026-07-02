# views.py — sample /api/items CRUD over the Item model.
#
# Degrade rule (the backend contract): the data routes need a database. When
# DATABASE_URL is UNSET, or the DB is unreachable, they return a clear 503 — while
# /healthz (project/urls.py) stays 200. NEVER hardcode credentials; the DSN comes only
# from the DATABASE_URL env (Secrets tab -> ESO -> Vault).
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.db.utils import Error as DBError
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Item
from .serializers import ItemSerializer

# Exceptions that mean "the database is not available right now" -> 503.
_DB_DOWN = (DBError, ImproperlyConfigured)
_503 = {"detail": "database unavailable: DATABASE_URL is not set or the database is unreachable"}


def _db_configured() -> bool:
    """True only when settings resolved a real DB engine. When DATABASE_URL is unset,
    settings.py selects the 'dummy' backend (see project/settings.py), which means the
    data routes must degrade to 503."""
    engine = settings.DATABASES.get("default", {}).get("ENGINE", "")
    return engine not in ("", "django.db.backends.dummy")


class ItemListCreate(APIView):
    def get(self, _request):
        if not _db_configured():
            return Response(_503, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        try:
            items = Item.objects.all()
            return Response(ItemSerializer(items, many=True).data)
        except _DB_DOWN:
            return Response(_503, status=status.HTTP_503_SERVICE_UNAVAILABLE)

    def post(self, request):
        if not _db_configured():
            return Response(_503, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        serializer = ItemSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            serializer.save()
        except _DB_DOWN:
            return Response(_503, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class ItemDetail(APIView):
    def _get_or_none(self, pk):
        return Item.objects.filter(pk=pk).first()

    def get(self, _request, pk):
        if not _db_configured():
            return Response(_503, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        try:
            item = self._get_or_none(pk)
        except _DB_DOWN:
            return Response(_503, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        if item is None:
            return Response({"detail": "item not found"}, status=status.HTTP_404_NOT_FOUND)
        return Response(ItemSerializer(item).data)

    def put(self, request, pk):
        if not _db_configured():
            return Response(_503, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        try:
            item = self._get_or_none(pk)
            if item is None:
                return Response({"detail": "item not found"}, status=status.HTTP_404_NOT_FOUND)
            serializer = ItemSerializer(item, data=request.data, partial=True)
            serializer.is_valid(raise_exception=True)
            serializer.save()
        except _DB_DOWN:
            return Response(_503, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response(serializer.data)

    def delete(self, _request, pk):
        if not _db_configured():
            return Response(_503, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        try:
            item = self._get_or_none(pk)
            if item is None:
                return Response({"detail": "item not found"}, status=status.HTTP_404_NOT_FOUND)
            item.delete()
        except _DB_DOWN:
            return Response(_503, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response(status=status.HTTP_204_NO_CONTENT)
