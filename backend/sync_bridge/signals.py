from django.db.models.signals import post_delete, post_save, pre_delete
from django.dispatch import receiver

from folders.models import Folder
from notes.models import Note
from videos.models import Video, ViewingSession

from .services import (
    capture_delete,
    capture_save,
    capture_video_save,
    capture_viewing_session_change,
)


@receiver(post_save, sender=Note, dispatch_uid="sync_bridge_note_save")
@receiver(post_save, sender=Folder, dispatch_uid="sync_bridge_folder_save")
def capture_local_save(sender, instance, **kwargs):
    capture_save(instance)


@receiver(post_save, sender=Video, dispatch_uid="sync_bridge_video_save")
def capture_video_update(sender, instance, **kwargs):
    capture_video_save(instance)


@receiver(post_save, sender=ViewingSession, dispatch_uid="sync_bridge_viewing_session_save")
def capture_viewing_session_save(sender, instance, **kwargs):
    capture_viewing_session_change(instance)


@receiver(post_delete, sender=ViewingSession, dispatch_uid="sync_bridge_viewing_session_delete")
def capture_viewing_session_delete(sender, instance, origin, **kwargs):
    capture_viewing_session_change(instance, origin)


@receiver(pre_delete, sender=Note, dispatch_uid="sync_bridge_note_delete")
@receiver(pre_delete, sender=Folder, dispatch_uid="sync_bridge_folder_delete")
def capture_local_delete(sender, instance, using, origin, **kwargs):
    capture_delete(instance, origin)
