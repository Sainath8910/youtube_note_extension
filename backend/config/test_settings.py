import os

os.environ.update(
    {
        "DJANGO_ENV": "test",
        "DEBUG": "false",
        "SECRET_KEY": "notes-bridge-test-only-secret",
        "SUPABASE_URL": "https://notes-bridge-test.supabase.co",
        "SUPABASE_JWT_AUDIENCE": "authenticated",
        "SUPABASE_JWT_SECRET": "notes-bridge-test-signing-key-only",
    }
)

from .settings import *  # noqa: E402,F403

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": ":memory:",
    }
}
