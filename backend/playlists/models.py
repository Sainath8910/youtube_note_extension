import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q


class Playlist(models.Model):
    class Kind(models.TextChoices):
        YOUTUBE = "YOUTUBE", "YouTube"
        CUSTOM = "CUSTOM", "Custom"

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="playlists",
    )
    sync_uuid = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    kind = models.CharField(max_length=10, choices=Kind.choices)
    title = models.CharField(max_length=255)
    channel_name = models.CharField(max_length=255, blank=True)
    youtube_playlist_id = models.CharField(max_length=128, null=True, blank=True)
    thumbnail_url = models.URLField(max_length=500, blank=True)
    playlist_url = models.URLField(max_length=500, blank=True)
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    trash_batch_id = models.UUIDField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["title", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=("user", "youtube_playlist_id"),
                condition=Q(youtube_playlist_id__isnull=False),
                name="unique_user_youtube_playlist",
            ),
        ]

    def save(self, *args, **kwargs):
        if self.pk is not None:
            database = kwargs.get("using") or self._state.db
            existing_uuid = (
                type(self)._base_manager.using(database)
                .filter(pk=self.pk)
                .values_list("sync_uuid", flat=True)
                .first()
            )
            if existing_uuid is not None and self.sync_uuid != existing_uuid:
                raise ValidationError(
                    {"sync_uuid": "A playlist synchronization UUID cannot be changed."}
                )
        return super().save(*args, **kwargs)

    def __str__(self):
        return self.title


class PlaylistVideo(models.Model):
    playlist = models.ForeignKey(
        Playlist,
        on_delete=models.CASCADE,
        related_name="items",
    )
    video = models.ForeignKey(
        "videos.Video",
        on_delete=models.CASCADE,
        related_name="playlist_items",
    )
    position = models.PositiveIntegerField(default=0)
    added_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["position", "id"]
        constraints = [
            models.UniqueConstraint(
                fields=("playlist", "video"),
                name="unique_video_per_playlist",
            ),
        ]

    def __str__(self):
        return f"{self.playlist}: {self.video}"
