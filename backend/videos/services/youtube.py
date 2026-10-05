import math
import re
from urllib.parse import urlparse

import yt_dlp


class YouTubeMetadataError(Exception):
    """Raised when metadata for a YouTube video cannot be resolved."""


class InvalidYouTubeVideoIdError(YouTubeMetadataError):
    """Raised when a supplied value is not a YouTube video ID."""


_YOUTUBE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{11}$")


def _string_value(value):
    return value.strip() if isinstance(value, str) else ""


def _channel_handle(info):
    uploader_id = _string_value(info.get("uploader_id"))
    if uploader_id.startswith("@"):
        return uploader_id

    channel_url = _string_value(info.get("channel_url")) or _string_value(
        info.get("uploader_url")
    )
    match = re.match(r"^/@([^/]+)", urlparse(channel_url).path)
    return f"@{match.group(1)}" if match else ""


def _channel_id(info):
    channel_id = _string_value(info.get("channel_id"))
    if channel_id:
        return channel_id

    channel_url = _string_value(info.get("channel_url")) or _string_value(
        info.get("uploader_url")
    )
    match = re.match(r"^/channel/([^/]+)", urlparse(channel_url).path)
    return match.group(1) if match else ""


def _duration_seconds(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return round(value)


def fetch_youtube_metadata(youtube_id: str) -> dict:
    if (
        not isinstance(youtube_id, str)
        or not _YOUTUBE_ID_PATTERN.fullmatch(youtube_id)
    ):
        raise InvalidYouTubeVideoIdError("Invalid YouTube video ID.")

    video_url = f"https://www.youtube.com/watch?v={youtube_id}"

    try:
        with yt_dlp.YoutubeDL(
            {
                "quiet": True,
                "no_warnings": True,
                "skip_download": True,
            }
        ) as youtube_dl:
            info = youtube_dl.extract_info(video_url, download=False)
    except (yt_dlp.utils.DownloadError, OSError) as error:
        raise YouTubeMetadataError(
            "YouTube did not provide metadata for this video."
        ) from error

    if not isinstance(info, dict):
        raise YouTubeMetadataError("YouTube returned no video metadata.")

    title = _string_value(info.get("title"))
    channel_name = (
        _string_value(info.get("channel"))
        or _string_value(info.get("uploader"))
        or _string_value(info.get("creator"))
    )
    if not title or not channel_name:
        raise YouTubeMetadataError("Required video metadata is unavailable.")

    return {
        "title": title,
        "channel_name": channel_name,
        "channel_handle": _channel_handle(info),
        "channel_id": _channel_id(info),
        "thumbnail_url": (
            f"https://i.ytimg.com/vi/{youtube_id}/hqdefault.jpg"
        ),
        "duration_seconds": _duration_seconds(info.get("duration")),
    }
