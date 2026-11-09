import uuid

from django.db import migrations, models


def populate_sync_uuids(apps, schema_editor):
    Note = apps.get_model("notes", "Note")
    database = schema_editor.connection.alias
    batch = []

    for note in Note.objects.using(database).filter(
        sync_uuid__isnull=True
    ).iterator(chunk_size=1000):
        note.sync_uuid = uuid.uuid4()
        batch.append(note)
        if len(batch) == 1000:
            Note.objects.using(database).bulk_update(batch, ["sync_uuid"])
            batch.clear()

    if batch:
        Note.objects.using(database).bulk_update(batch, ["sync_uuid"])


def clear_sync_uuids(apps, schema_editor):
    Note = apps.get_model("notes", "Note")
    Note.objects.using(schema_editor.connection.alias).update(sync_uuid=None)


class Migration(migrations.Migration):

    dependencies = [
        ("notes", "0003_note_document_alter_note_content"),
    ]

    operations = [
        migrations.AddField(
            model_name="note",
            name="sync_uuid",
            field=models.UUIDField(editable=False, null=True),
        ),
        migrations.RunPython(populate_sync_uuids, clear_sync_uuids),
        migrations.AlterField(
            model_name="note",
            name="sync_uuid",
            field=models.UUIDField(
                default=uuid.uuid4,
                editable=False,
                unique=True,
            ),
        ),
    ]
