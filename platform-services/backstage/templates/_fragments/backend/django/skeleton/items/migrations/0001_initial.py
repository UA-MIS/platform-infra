# Initial migration for the sample Item model. Apply with `python manage.py migrate`
# at deploy time (see MIGRATIONS.md), NOT from the app process.
from django.db import migrations, models


class Migration(migrations.Migration):
    initial = True
    dependencies = []

    operations = [
        migrations.CreateModel(
            name="Item",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ("name", models.CharField(db_index=True, max_length=255)),
                ("description", models.CharField(blank=True, max_length=1024, null=True)),
            ],
            options={"ordering": ["id"]},
        ),
    ]
