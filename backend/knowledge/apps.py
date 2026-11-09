from django.apps import AppConfig
from django.db.models.signals import post_save


class KnowledgeConfig(AppConfig):
    name = "knowledge"

    def ready(self):
        from knowledge.models import KnowledgeChunk
        from notes.models import Note
        from sync_bridge.models import IndexingJob

        def update_note_index(sender, instance, update_fields=None, **kwargs):
            if instance.deleted_at is not None:
                KnowledgeChunk.objects.filter(note=instance).delete()
                IndexingJob.objects.filter(
                    owner=instance.user, note_uuid=instance.sync_uuid
                ).update(status="completed", last_error="")
            elif update_fields is not None and "deleted_at" in update_fields:
                IndexingJob.objects.update_or_create(
                    owner=instance.user,
                    note_uuid=instance.sync_uuid,
                    defaults={"status": "pending", "last_error": ""},
                )

        post_save.connect(
            update_note_index,
            sender=Note,
            dispatch_uid="knowledge_note_trash_index",
        )
