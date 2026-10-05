from unittest import TestCase
from unittest.mock import MagicMock, patch

import yt_dlp

from videos.services.youtube import (
    InvalidYouTubeVideoIdError,
    YouTubeMetadataError,
    fetch_youtube_metadata,
)


class FetchYouTubeMetadataTests(TestCase):
    @patch("videos.services.youtube.yt_dlp.YoutubeDL")
    def test_returns_backend_resolved_metadata(self, youtube_dl_class):
        info = {
            "title": "Example video",
            "channel": "Example channel",
            "uploader_id": "@example",
            "channel_id": "UCexample",
            "duration": 92.6,
        }
        youtube_dl = MagicMock()
        youtube_dl.extract_info.return_value = info
        youtube_dl_class.return_value.__enter__.return_value = youtube_dl

        metadata = fetch_youtube_metadata("abcdefghijk")

        self.assertEqual(
            metadata,
            {
                "title": "Example video",
                "channel_name": "Example channel",
                "channel_handle": "@example",
                "channel_id": "UCexample",
                "thumbnail_url": (
                    "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"
                ),
                "duration_seconds": 93,
            },
        )
        youtube_dl.extract_info.assert_called_once_with(
            "https://www.youtube.com/watch?v=abcdefghijk",
            download=False,
        )

    @patch("videos.services.youtube.yt_dlp.YoutubeDL")
    def test_rejects_missing_required_metadata(self, youtube_dl_class):
        youtube_dl = MagicMock()
        youtube_dl.extract_info.return_value = {"title": "No channel"}
        youtube_dl_class.return_value.__enter__.return_value = youtube_dl

        with self.assertRaises(YouTubeMetadataError):
            fetch_youtube_metadata("abcdefghijk")

    @patch("videos.services.youtube.yt_dlp.YoutubeDL")
    def test_wraps_youtube_extraction_failures(self, youtube_dl_class):
        youtube_dl = MagicMock()
        youtube_dl.extract_info.side_effect = yt_dlp.utils.DownloadError(
            "unavailable"
        )
        youtube_dl_class.return_value.__enter__.return_value = youtube_dl

        with self.assertRaises(YouTubeMetadataError):
            fetch_youtube_metadata("abcdefghijk")

    def test_rejects_invalid_video_ids_without_fetching(self):
        with patch("videos.services.youtube.yt_dlp.YoutubeDL") as youtube_dl:
            with self.assertRaises(InvalidYouTubeVideoIdError):
                fetch_youtube_metadata("not-an-id")

        youtube_dl.assert_not_called()
