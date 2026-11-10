from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver

from sync_bridge.services import capture_save

from .models import Playlist, PlaylistVideo


@receiver(post_save, sender=Playlist, dispatch_uid="playlist_sync_save")
def capture_playlist_save(sender, instance, **kwargs):
    capture_save(instance)


@receiver(post_save, sender=PlaylistVideo, dispatch_uid="playlist_video_sync_save")
@receiver(post_delete, sender=PlaylistVideo, dispatch_uid="playlist_video_sync_delete")
def capture_playlist_video_change(sender, instance, **kwargs):
    if instance.playlist_id:
        playlist = Playlist.objects.filter(pk=instance.playlist_id).first()
        if playlist is not None:
            capture_save(playlist)
