import uuid

from django.db import migrations


def backfill_trash_snapshot_fields(apps, schema_editor):
    database = schema_editor.connection.alias
    RecordState = apps.get_model("sync_bridge", "RecordState")
    ChangeEvent = apps.get_model("sync_bridge", "ChangeEvent")
    Note = apps.get_model("notes", "Note")
    Folder = apps.get_model("folders", "Folder")

    states = RecordState.objects.using(database).filter(
        deleted=False, needs_repair=False
    )
    for state in states.iterator(chunk_size=200):
        model = Note if state.entity == "note" else Folder
        record = model.objects.using(database).filter(
            user_id=state.owner_id, sync_uuid=state.record_uuid
        ).first()
        if record is None:
            continue
        snapshot = dict(state.snapshot or {})
        snapshot["deleted_at"] = (
            record.deleted_at.isoformat() if record.deleted_at else None
        )
        snapshot["trash_batch_id"] = (
            str(record.trash_batch_id) if record.trash_batch_id else None
        )
        if snapshot == state.snapshot:
            continue
        state.revision += 1
        state.snapshot = snapshot
        state.save(using=database, update_fields=("revision", "snapshot"))
        ChangeEvent.objects.using(database).create(
            owner_id=state.owner_id,
            entity=state.entity,
            record_uuid=state.record_uuid,
            revision=state.revision,
            snapshot=snapshot,
            deleted=False,
            operation_id=uuid.uuid4(),
            origin_installation=state.origin_installation,
            origin_operation=state.origin_operation,
        )


class Migration(migrations.Migration):

    dependencies = [
        ("sync_bridge", "0004_backfill_video_payloads"),
        ("notes", "0005_note_deleted_at_note_trash_batch_id"),
        (
            "folders",
            "0006_remove_folder_unique_folder_name_per_parent_and_more",
        ),
    ]

    operations = [
        migrations.RunPython(backfill_trash_snapshot_fields, migrations.RunPython.noop),
    ]
