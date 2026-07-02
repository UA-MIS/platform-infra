# serializers.py — the API contract (request/response shape) for Item.
from rest_framework import serializers

from .models import Item


class ItemSerializer(serializers.ModelSerializer):
    class Meta:
        model = Item
        fields = ["id", "name", "description"]
        read_only_fields = ["id"]
