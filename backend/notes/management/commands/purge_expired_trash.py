from django.core.management.base import BaseCommand
from django.db import transaction

from notes.trash import expired_trash
from sync_bridge.services import write_change


class Command(BaseCommand):
    help = "Permanently delete Notes and Folders after their 30-day trash period."

    @transaction.atomic
    def handle(self, *args, **options):
        notes, folders = expired_trash()
        deleted_notes = 0
        deleted_folders = 0

        for note in notes.select_related("user").iterator(chunk_size=100):
            write_change(
                note.user,
                "note",
                note.sync_uuid,
                {"deleted_at": note.deleted_at.isoformat()},
                deleted=True,
            )
            note.delete()
            deleted_notes += 1

        folder_rows = list(folders.select_related("parent", "user"))
        folder_ids = {folder.pk for folder in folder_rows}
        folder_by_id = {folder.pk: folder for folder in folder_rows}
        depths = {}

        def depth(folder, visited=None):
            if folder.pk in depths:
                return depths[folder.pk]
            visited = visited or set()
            if folder.pk in visited or folder.parent_id not in folder_ids:
                return 0
            visited.add(folder.pk)
            parent = folder_by_id.get(folder.parent_id)
            value = 1 + depth(parent, visited) if parent else 0
            depths[folder.pk] = value
            return value

        for folder in sorted(folder_rows, key=depth, reverse=True):
            write_change(
                folder.user,
                "folder",
                folder.sync_uuid,
                {"deleted_at": folder.deleted_at.isoformat()},
                deleted=True,
            )
            folder.delete()
            deleted_folders += 1

        self.stdout.write(
            self.style.SUCCESS(
                f"Permanently deleted {deleted_notes} note(s) and "
                f"{deleted_folders} folder(s)."
            )
        )
