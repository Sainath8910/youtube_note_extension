from django.contrib.auth.models import AbstractUser
from django.db import models


class User(AbstractUser):
    supabase_uid = models.UUIDField(
        null=True,
        blank=True,
        unique=True,
    )