from datetime import timedelta

from django.core.management.base import BaseCommand
from django.db.models import Q
from django.utils import timezone

from knowledge.services.indexing import index_note
from notes.models import Note

from sync_bridge.models import IndexingJob


class Command(BaseCommand):
    help = "Process recoverable Notes Bridge note-indexing jobs."
    max_attempts = 5
    base_retry_delay = timedelta(minutes=1)
    max_retry_delay = timedelta(hours=1)
    stale_running_after = timedelta(hours=1)

    def handle(self, *args, **options):
        now = timezone.now()
        due = Q(status="pending")
        due |= Q(
            status="running",
            attempts__lt=self.max_attempts,
            updated_at__lte=now - self.stale_running_after,
        )
        for attempts in range(self.max_attempts):
            delay = min(
                self.base_retry_delay * (2 ** max(0, attempts - 1)),
                self.max_retry_delay,
            )
            due |= Q(
                status="failed", attempts=attempts,
                updated_at__lte=now - delay,
            )
        jobs = IndexingJob.objects.filter(due).order_by("created_at")
        completed = 0
        failed = 0
        for job in jobs.iterator(chunk_size=100):
            job.status = "running"
            job.attempts += 1
            job.last_error = ""
            job.save(update_fields=("status", "attempts", "last_error", "updated_at"))
            note = Note.objects.filter(
                user=job.owner, sync_uuid=job.note_uuid,
                deleted_at__isnull=True,
            ).select_related("user", "video", "folder").first()
            if note is None:
                job.status = "completed"
                job.last_error = ""
            else:
                try:
                    index_note(note)
                except Exception as error:
                    job.status = "failed"
                    job.last_error = type(error).__name__
                    self.stderr.write(
                        f"Indexing job for note {job.note_uuid} failed "
                        f"({job.last_error})."
                    )
                    failed += 1
                else:
                    job.status = "completed"
                    completed += 1
            job.save(update_fields=("status", "last_error", "updated_at"))
        self.stdout.write(f"Completed {completed} indexing job(s); {failed} failed.")
