import uuid

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q


class Folder(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="folders",
    )
    sync_uuid = models.UUIDField(
        default=uuid.uuid4,
        unique=True,
        editable=False,
    )

    name = models.CharField(max_length=255)

    parent = models.ForeignKey(
        "self",
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name="children",
    )

    description = models.TextField(blank=True)

    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)
    trash_batch_id = models.UUIDField(null=True, blank=True, db_index=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "parent", "name"],
                condition=Q(deleted_at__isnull=True),
                name="unique_folder_name_per_parent",
            ),
            models.UniqueConstraint(
                fields=["user", "name"],
                condition=Q(parent__isnull=True, deleted_at__isnull=True),
                name="unique_root_folder_name_per_user",
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
            if (
                existing_uuid is not None
                and self._meta.get_field("sync_uuid").to_python(self.sync_uuid)
                != existing_uuid
            ):
                raise ValidationError(
                    {"sync_uuid": "A folder synchronization UUID cannot be changed."}
                )
        return super().save(*args, **kwargs)

    def __str__(self):
        return self.name