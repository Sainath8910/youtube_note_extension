from django.conf import settings
from django.db import models
from django.db.models import Q


class Folder(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="folders",
    )

    name = models.CharField(max_length=255)

    parent = models.ForeignKey(
        "self",
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name="children",
    )

    description = models.TextField(blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "parent", "name"],
                name="unique_folder_name_per_parent",
            ),
            models.UniqueConstraint(
                fields=["user", "name"],
                condition=Q(parent__isnull=True),
                name="unique_root_folder_name_per_user",
            ),
        ]

    def __str__(self):
        return self.name