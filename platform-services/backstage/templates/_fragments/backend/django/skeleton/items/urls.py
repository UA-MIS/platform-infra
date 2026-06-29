# urls.py — the sample API, mounted under /api (see project/urls.py) so the platform
# ingress (/api -> this backend) reaches it: /api/items and /api/items/<id>.
from django.urls import path

from .views import ItemDetail, ItemListCreate

urlpatterns = [
    path("items", ItemListCreate.as_view()),
    path("items/<int:pk>", ItemDetail.as_view()),
]
