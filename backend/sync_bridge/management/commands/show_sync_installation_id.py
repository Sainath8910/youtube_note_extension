from django.core.management.base import BaseCommand

from sync_bridge.services import installation_uuid


class Command(BaseCommand):
    help = "Print this backend's Notes Bridge installation UUID."

    def handle(self, *args, **options):
        self.stdout.write(str(installation_uuid()))
