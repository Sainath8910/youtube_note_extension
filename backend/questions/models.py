from django.conf import settings
from django.db import models


class Question(models.Model):

    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="questions",
    )

    question = models.TextField()

    answer = models.TextField(
        blank=True,
    )

    video = models.ForeignKey(
        "videos.Video",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="questions",
    )

    folder = models.ForeignKey(
        "folders.Folder",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="questions",
    )

    created_at = models.DateTimeField(
        auto_now_add=True,
    )

    def __str__(self):
        return self.question[:100]