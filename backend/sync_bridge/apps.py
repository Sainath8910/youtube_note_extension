from django.apps import AppConfig


class SyncBridgeConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "sync_bridge"

    def ready(self):
        from . import signals

        return signals
