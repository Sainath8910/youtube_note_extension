from uuid import uuid4

from django.conf import settings
from django.db import models
from pgvector.django import VectorField


class KnowledgeChunk(models.Model):
    class ContentType(models.TextChoices):
        NOTE = "NOTE", "Note"
        NOTE_BLOCK = "NOTE_BLOCK", "Note block"
        TRANSCRIPT_CHUNK = "TRANSCRIPT_CHUNK", "Transcript chunk"
        ANALYSIS_CHUNK = "ANALYSIS_CHUNK", "Analysis chunk"

    class SourceType(models.TextChoices):
        NOTE = "NOTE", "User note"
        VIDEO_TRANSCRIPT = "VIDEO_TRANSCRIPT", "Video transcript"
        VIDEO_ANALYSIS = "VIDEO_ANALYSIS", "Video analysis"

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="knowledge_chunks",
        db_index=False,
    )
    note = models.ForeignKey(
        "notes.Note",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="knowledge_chunks",
        db_index=False,
    )
    video = models.ForeignKey(
        "videos.Video",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="knowledge_chunks",
        db_index=False,
    )
    folder = models.ForeignKey(
        "folders.Folder",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="knowledge_chunks",
        db_index=False,
    )
    content = models.TextField()
    content_type = models.CharField(
        max_length=20,
        choices=ContentType.choices,
    )
    source_type = models.CharField(
        max_length=20,
        choices=SourceType.choices,
        default=SourceType.NOTE,
    )
    source_block_id = models.CharField(
        max_length=255,
        null=True,
        blank=True,
    )
    chunk_index = models.PositiveIntegerField(default=0)
    metadata = models.JSONField(default=dict)
    embedding = VectorField(
        dimensions=1024,
        null=True,
        blank=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            models.Index(fields=["user"], name="knowledge_chunk_user_idx"),
            models.Index(
                fields=["user", "note"],
                name="knowledge_chunk_user_note_idx",
            ),
            models.Index(
                fields=["user", "video"],
                name="knowledge_chunk_user_video_idx",
            ),
            models.Index(
                fields=["user", "folder"],
                name="knowledge_user_folder_idx",
            ),
            models.Index(
                fields=["user", "content_type"],
                name="knowledge_chunk_user_type_idx",
            ),
        ]

    def __str__(self):
        return f"{self.get_content_type_display()} chunk for {self.user}"

class PreviousContextJobStatus(models.TextChoices):
    PENDING = "PENDING", "Pending"
    PROCESSING = "PROCESSING", "Processing"
    READY = "READY", "Ready"
    FAILED = "FAILED", "Failed"

class PreviousContextJob(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid4, editable=False)
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    youtube_id = models.CharField(max_length=255)
    video = models.ForeignKey("videos.Video", on_delete=models.SET_NULL, null=True, blank=True)
    status = models.CharField(
        max_length=20,
        choices=PreviousContextJobStatus.choices,
        default=PreviousContextJobStatus.PENDING
    )
    result = models.JSONField(null=True, blank=True)
    error = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    @property
    def job_id(self) -> str:
        return str(self.id)
