import uuid

from django.db import migrations, models


def populate_sync_uuids(apps, schema_editor):
    Folder = apps.get_model("folders", "Folder")
    database = schema_editor.connection.alias
    batch = []

    for folder in Folder.objects.using(database).filter(
        sync_uuid__isnull=True
    ).iterator(chunk_size=1000):
        folder.sync_uuid = uuid.uuid4()
        batch.append(folder)
        if len(batch) == 1000:
            Folder.objects.using(database).bulk_update(batch, ["sync_uuid"])
            batch.clear()

    if batch:
        Folder.objects.using(database).bulk_update(batch, ["sync_uuid"])


def clear_sync_uuids(apps, schema_editor):
    Folder = apps.get_model("folders", "Folder")
    Folder.objects.using(schema_editor.connection.alias).update(sync_uuid=None)


class Migration(migrations.Migration):

    dependencies = [
        ("folders", "0003_folder_unique_root_folder_name_per_user"),
    ]

    operations = [
        migrations.AddField(
            model_name="folder",
            name="sync_uuid",
            field=models.UUIDField(editable=False, null=True),
        ),
        migrations.RunPython(populate_sync_uuids, clear_sync_uuids),
        migrations.AlterField(
            model_name="folder",
            name="sync_uuid",
            field=models.UUIDField(
                default=uuid.uuid4,
                editable=False,
                unique=True,
            ),
        ),
    ]
