from django.core.management.base import BaseCommand, CommandError

from knowledge.services.indexing import index_note
from notes.models import Note


class Command(BaseCommand):
    help = "Create or refresh knowledge chunks for every existing note."

    def handle(self, *args, **options):
        queryset = Note.objects.select_related(
            "user",
            "video",
            "folder",
        ).order_by("pk")
        total = queryset.count()
        failures = []
        self.stdout.write(f"Indexing {total} notes...")

        for index, note in enumerate(
            queryset.iterator(chunk_size=200),
            start=1,
        ):
            try:
                index_note(note)
            except Exception as error:
                failures.append(note.pk)
                self.stderr.write(
                    f"[{index}/{total}] Failed note {note.pk} "
                    f"({type(error).__name__})"
                )
            else:
                self.stdout.write(f"[{index}/{total}] Indexed note {note.pk}")

        indexed = total - len(failures)
        self.stdout.write(
            f"Completed: {indexed} indexed, {len(failures)} failed"
        )
        if failures:
            failed_ids = ", ".join(str(note_id) for note_id in failures)
            raise CommandError(
                f"Could not index {len(failures)} note(s): {failed_ids}"
            )
