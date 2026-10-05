from django.conf import settings
from django.db import models


class Note(models.Model):

    class NoteType(models.TextChoices):
        VIDEO = "VIDEO", "Video"
        STANDALONE = "STANDALONE", "Standalone"

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="notes",
    )

    title = models.CharField(
        max_length=500,
    )

    # Structured rich-note document.
    #
    # Example:
    # {
    #     "version": 1,
    #     "blocks": [
    #         {
    #             "id": "block-1",
    #             "type": "paragraph",
    #             "content": "Binary search divides the search space."
    #         },
    #         {
    #             "id": "block-2",
    #             "type": "equation",
    #             "content": "T(n) = T(n/2) + O(1)"
    #         }
    #     ]
    # }
    document = models.JSONField(
        default=dict,
    )

    # Keep the old field temporarily during migration.
    content = models.TextField(
        blank=True,
    )

    note_type = models.CharField(
        max_length=20,
        choices=NoteType.choices,
    )

    folder = models.ForeignKey(
        "folders.Folder",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="notes",
    )

    video = models.ForeignKey(
        "videos.Video",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="notes",
    )

    # Keep temporarily. Later timestamps will become blocks
    # inside the document.
    timestamp_seconds = models.PositiveIntegerField(
        null=True,
        blank=True,
    )

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]

    def __str__(self):
        return self.title