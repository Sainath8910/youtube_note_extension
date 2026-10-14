from config.settings import *

INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "users",
    "folders",
    "videos",
    "notes",
]

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": ":memory:",
    }
}

MIGRATION_MODULES = {
    "auth": None,
    "contenttypes": None,
    "users": None,
    "folders": None,
    "videos": None,
    "notes": None,
}

ROOT_URLCONF = "config.import_test_urls"
