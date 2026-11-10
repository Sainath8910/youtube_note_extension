import re
from urllib.parse import quote

from django.db.models import Max
from rest_framework.exceptions import ValidationError

from videos.models import Video

from .models import Playlist, PlaylistVideo

_YOUTUBE_PLAYLIST_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def add_video_to_youtube_playlist(
    *,
    user,
    video: Video,
    playlist_id: str,
    title: str = "",
    thumbnail_url: str = "",
    channel_name: str = "",
    playlist_videos: list | None = None,
    current_position: int | None = None,
) -> Playlist:
    if not isinstance(playlist_id, str) or not _YOUTUBE_PLAYLIST_ID.fullmatch(playlist_id):
        raise ValidationError({"youtube_playlist_id": "The YouTube playlist ID is invalid."})
    title = title.strip() if isinstance(title, str) else ""
    provided_title = title not in {
        "",
        "Untitled YouTube playlist",
        f"YouTube playlist {playlist_id}",
    }
    if not title:
        title = "Untitled YouTube playlist"
    if len(title) > 255:
        title = title[:255]
    thumbnail_url = thumbnail_url.strip() if isinstance(thumbnail_url, str) else ""
    if len(thumbnail_url) > 500:
        thumbnail_url = ""
    channel_name = channel_name.strip()[:255] if isinstance(channel_name, str) else ""

    playlist, _ = Playlist.objects.get_or_create(
        user=user,
        youtube_playlist_id=playlist_id,
        defaults={
            "kind": Playlist.Kind.YOUTUBE,
            "title": title,
            "channel_name": channel_name,
            "thumbnail_url": thumbnail_url or video.thumbnail_url,
            "playlist_url": (
                f"https://www.youtube.com/playlist?list={quote(playlist_id)}"
            ),
        },
    )
    fields = []
    if playlist.deleted_at is not None:
        playlist.deleted_at = None
        playlist.trash_batch_id = None
        fields.extend(("deleted_at", "trash_batch_id"))
    if provided_title and playlist.title != title:
        playlist.title = title
        fields.append("title")
    if thumbnail_url and playlist.thumbnail_url != thumbnail_url:
        playlist.thumbnail_url = thumbnail_url
        fields.append("thumbnail_url")
    if channel_name and playlist.channel_name != channel_name:
        playlist.channel_name = channel_name
        fields.append("channel_name")
    if fields:
        fields.append("updated_at")
        playlist.save(update_fields=fields)

    imported_ids = set()
    for item in playlist_videos or []:
        if not isinstance(item, dict):
            continue
        youtube_id = item.get("youtube_id")
        position = item.get("position")
        if (
            not isinstance(youtube_id, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{11}", youtube_id)
            or not isinstance(position, int)
            or isinstance(position, bool)
            or position < 0
        ):
            continue
        imported_ids.add(youtube_id)
        video_metadata = {
            "title": item.get("title", ""),
            "channel_name": item.get("channel_name", ""),
            "thumbnail_url": item.get("thumbnail_url", ""),
        }
        video_metadata = {
            field: value[:limit] if isinstance(value, str) else ""
            for field, value, limit in (
                ("title", video_metadata["title"], 500),
                ("channel_name", video_metadata["channel_name"], 255),
                ("thumbnail_url", video_metadata["thumbnail_url"], 500),
            )
        }
        item_video, _ = Video.objects.get_or_create(
            youtube_id=youtube_id,
            defaults=video_metadata,
        )
        changed_fields = []
        for field, value in video_metadata.items():
            if value and not getattr(item_video, field):
                setattr(item_video, field, value)
                changed_fields.append(field)
        if changed_fields:
            changed_fields.append("updated_at")
            item_video.save(update_fields=changed_fields)
        PlaylistVideo.objects.update_or_create(
            playlist=playlist,
            video=item_video,
            defaults={"position": position},
        )

    last_position = playlist.items.aggregate(position=Max("position"))["position"]
    fallback_position = (
        current_position
        if isinstance(current_position, int)
        and not isinstance(current_position, bool)
        and current_position >= 0
        else (last_position if last_position is not None else -1) + 1
    )
    if video.youtube_id not in imported_ids:
        PlaylistVideo.objects.get_or_create(
            playlist=playlist,
            video=video,
            defaults={"position": fallback_position},
        )
    return playlist
