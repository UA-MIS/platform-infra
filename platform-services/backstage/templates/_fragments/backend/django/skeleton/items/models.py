# models.py — a sample model so the CRUD API has something to persist. Replace `Item`
# with your own domain models. String columns are length-bounded because MySQL requires
# an explicit length on VARCHAR.
from django.db import models


class Item(models.Model):
    name = models.CharField(max_length=255, db_index=True)
    description = models.CharField(max_length=1024, null=True, blank=True)

    class Meta:
        ordering = ["id"]

    def __str__(self):
        return self.name
