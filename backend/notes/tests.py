from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from notes.models import Note
from videos.models import Video
from videos.services.youtube import YouTubeMetadataError


class VideoNoteCreateTests(TestCase):
    youtube_id = "test1234567"
    metadata = {
        "title": "Test Video",
        "channel_name": "Test Channel",
        "channel_handle": "@testchannel",
        "channel_id": "UC_TEST",
        "thumbnail_url": (
            "https://i.ytimg.com/vi/test123/hqdefault.jpg"
        ),
        "duration_seconds": 300,
    }

    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create_user(
            username="note-test-user",
            password="test-password",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        index_patcher = patch("notes.views.index_note")
        self.index_note = index_patcher.start()
        self.addCleanup(index_patcher.stop)
        self.payload = {
            "youtube_id": self.youtube_id,
            "title": "Test Note",
            "content": "Testing video notes.",
            "document": {
                "version": 1,
                "blocks": [
                    {
                        "id": "block-1",
                        "type": "paragraph",
                        "content": "Testing video notes.",
                    }
                ],
            },
            "note_type": "VIDEO",
            "timestamp_seconds": None,
        }

    @patch("notes.views.fetch_youtube_metadata")
    def test_create_note_with_resolved_metadata(self, fetch_metadata):
        fetch_metadata.return_value = self.metadata

        response = self.client.post(
            "/api/notes/video/",
            self.payload,
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.data["video_created"])
        self.assertTrue(response.data["metadata_resolved"])
        self.assertEqual(response.data["video"]["title"], "Test Video")
        self.assertEqual(response.data["note"]["title"], "Test Note")
        video = Video.objects.get(youtube_id=self.youtube_id)
        self.assertEqual(video.title, "Test Video")
        self.assertEqual(video.channel_name, "Test Channel")
        self.assertEqual(video.channel_handle, "@testchannel")
        self.assertEqual(video.channel_id, "UC_TEST")
        self.assertEqual(video.thumbnail_url, self.metadata["thumbnail_url"])
        self.assertEqual(video.duration_seconds, 300)
        self.assertEqual(Note.objects.filter(video=video).count(), 1)

    @patch("notes.views.fetch_youtube_metadata")
    def test_create_note_with_fallback_when_metadata_fails(self, fetch_metadata):
        fetch_metadata.side_effect = YouTubeMetadataError("internal details")

        response = self.client.post(
            "/api/notes/video/",
            self.payload,
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertFalse(response.data["metadata_resolved"])
        self.assertEqual(response.data["video"]["youtube_id"], self.youtube_id)
        self.assertEqual(response.data["video"]["title"], "")
        self.assertEqual(response.data["note"]["title"], "Test Note")
        video = Video.objects.get(youtube_id=self.youtube_id)
        self.assertEqual(video.title, "")
        self.assertEqual(video.channel_name, "")
        self.assertEqual(video.channel_handle, "")
        self.assertEqual(video.channel_id, "")
        self.assertEqual(
            video.thumbnail_url,
            f"https://i.ytimg.com/vi/{self.youtube_id}/hqdefault.jpg",
        )
        self.assertIsNone(video.duration_seconds)
        self.assertEqual(Note.objects.filter(video=video).count(), 1)
        self.assertNotIn("internal details", str(response.data))

    @patch("notes.views.fetch_youtube_metadata")
    def test_metadata_failure_preserves_existing_video_metadata(
        self,
        fetch_metadata,
    ):
        fetch_metadata.side_effect = YouTubeMetadataError("internal details")
        video = Video.objects.create(
            youtube_id=self.youtube_id,
            title="Previously resolved title",
            channel_name="Previously resolved channel",
            channel_handle="@previous",
            channel_id="UC_PREVIOUS",
            thumbnail_url="https://example.com/previous.jpg",
            duration_seconds=120,
        )

        response = self.client.post(
            "/api/notes/video/",
            self.payload,
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertFalse(response.data["video_created"])
        self.assertEqual(response.data["note"]["title"], "Test Note")
        video.refresh_from_db()
        self.assertEqual(video.title, "Previously resolved title")
        self.assertEqual(video.channel_name, "Previously resolved channel")
        self.assertEqual(video.channel_handle, "@previous")
        self.assertEqual(video.channel_id, "UC_PREVIOUS")
        self.assertEqual(video.thumbnail_url, "https://example.com/previous.jpg")
        self.assertEqual(video.duration_seconds, 120)
        self.assertEqual(Note.objects.filter(video=video).count(), 1)

# Create your tests here.
