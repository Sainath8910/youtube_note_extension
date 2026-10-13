from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    supabase_uid = models.UUIDField(
        null=True,
        blank=True,
        unique=True,
    )
    public_username = models.CharField(
        max_length=30,
        null=True,
        blank=True,
    )

    class Meta(AbstractUser.Meta):
        constraints = [
            models.UniqueConstraint(
                models.functions.Lower("public_username"),
                name="users_public_username_ci_unique",
            ),
        ]