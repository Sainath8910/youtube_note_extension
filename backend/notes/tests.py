from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from folders.models import Folder
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

    def test_notes_include_resolved_video_metadata(self):
        video = Video.objects.create(
            youtube_id=self.youtube_id,
            title="Video title",
            channel_name="Channel name",
            channel_handle="@channel",
            thumbnail_url="https://example.com/thumbnail.jpg",
        )
        note = Note.objects.create(
            user=self.user,
            title="Video note",
            content="Note content",
            note_type=Note.NoteType.VIDEO,
            video=video,
            timestamp_seconds=92,
        )

        response = self.client.get("/api/notes/")

        self.assertEqual(response.status_code, 200)
        returned_note = next(item for item in response.data if item["id"] == note.id)
        self.assertEqual(returned_note["video"], video.id)
        self.assertEqual(
            returned_note["video_detail"],
            {
                "id": video.id,
                "youtube_id": self.youtube_id,
                "title": "Video title",
                "channel_name": "Channel name",
                "channel_handle": "@channel",
                "thumbnail_url": "https://example.com/thumbnail.jpg",
            },
        )


class NoteFolderOwnershipTests(TestCase):
    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create_user(username="note-folder-owner")
        self.other_user = user_model.objects.create_user(
            username="other-note-folder-owner",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.folder = Folder.objects.create(user=self.user, name="Own folder")
        self.foreign_folder = Folder.objects.create(
            user=self.other_user,
            name="Foreign folder",
        )
        self.note = Note.objects.create(
            user=self.user,
            title="Standalone note",
            content="Existing content",
            document={
                "version": 1,
                "blocks": [
                    {
                        "id": "block-1",
                        "type": "paragraph",
                        "content": "Existing content",
                    }
                ],
            },
            note_type=Note.NoteType.STANDALONE,
            folder=self.folder,
        )
        self.standalone_payload = {
            "title": "New standalone note",
            "content": "Note content",
            "document": {
                "version": 1,
                "blocks": [
                    {
                        "id": "new-block",
                        "type": "paragraph",
                        "content": "Note content",
                    }
                ],
            },
            "note_type": "STANDALONE",
            "video": None,
            "timestamp_seconds": None,
        }

    @patch("notes.views.index_note")
    def test_user_can_assign_own_folder_when_creating_note(self, index_note):
        payload = {
            **self.standalone_payload,
            "folder": self.folder.pk,
        }

        response = self.client.post(
            "/api/notes/",
            payload,
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.data["folder"], self.folder.pk)
        self.assertEqual(
            response.data["folder_path"],
            [{"id": self.folder.pk, "name": self.folder.name}],
        )
        index_note.assert_called_once()

    @patch("notes.views.index_note")
    def test_user_cannot_assign_foreign_folder_when_creating_note(
        self,
        index_note,
    ):
        payload = {
            **self.standalone_payload,
            "folder": self.foreign_folder.pk,
        }

        response = self.client.post(
            "/api/notes/",
            payload,
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(Note.objects.filter(user=self.user).count(), 1)
        index_note.assert_not_called()
        self.assertNotIn(self.foreign_folder.name, str(response.data))

    @patch("notes.views.index_note")
    def test_user_cannot_assign_foreign_folder_through_patch(self, index_note):
        response = self.client.patch(
            f"/api/notes/{self.note.pk}/",
            {"folder": self.foreign_folder.pk},
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.note.refresh_from_db()
        self.assertEqual(self.note.folder, self.folder)
        index_note.assert_not_called()
        self.assertNotIn(self.foreign_folder.name, str(response.data))

    @patch("notes.views.index_note")
    def test_user_cannot_assign_foreign_folder_through_put(self, index_note):
        payload = {
            **self.standalone_payload,
            "folder": self.foreign_folder.pk,
        }

        response = self.client.put(
            f"/api/notes/{self.note.pk}/",
            payload,
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.note.refresh_from_db()
        self.assertEqual(self.note.folder, self.folder)
        index_note.assert_not_called()
        self.assertNotIn(self.foreign_folder.name, str(response.data))

    @patch("notes.views.fetch_youtube_metadata")
    @patch("notes.views.index_note")
    def test_video_note_create_rejects_foreign_folder(
        self,
        index_note,
        fetch_metadata,
    ):
        fetch_metadata.return_value = VideoNoteCreateTests.metadata
        payload = {
            **self.standalone_payload,
            "youtube_id": VideoNoteCreateTests.youtube_id,
            "note_type": "VIDEO",
            "folder": self.foreign_folder.pk,
        }

        response = self.client.post(
            "/api/notes/video/",
            payload,
            format="json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertFalse(Note.objects.filter(title=payload["title"]).exists())
        index_note.assert_not_called()
        self.assertNotIn(self.foreign_folder.name, str(response.data))

    @patch("notes.views.index_note")
    def test_folder_null_removes_note_folder(self, index_note):
        response = self.client.patch(
            f"/api/notes/{self.note.pk}/",
            {"folder": None},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["folder_path"], [])
        self.note.refresh_from_db()
        self.assertIsNone(self.note.folder)
        index_note.assert_called_once()
        self.assertEqual(Note.objects.filter(pk=self.note.pk).count(), 1)

    @patch("notes.views.index_note")
    def test_patch_moves_note_between_owned_folders_without_duplication(
        self,
        index_note,
    ):
        destination = Folder.objects.create(
            user=self.user,
            name="Destination folder",
        )

        response = self.client.patch(
            f"/api/notes/{self.note.pk}/",
            {"folder": destination.pk},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.note.refresh_from_db()
        self.assertEqual(self.note.folder, destination)
        self.assertEqual(
            response.data["folder_path"],
            [{"id": destination.pk, "name": destination.name}],
        )
        self.assertEqual(Note.objects.filter(user=self.user).count(), 1)
        index_note.assert_called_once()

    def test_note_folder_path_is_root_to_current_and_tracks_ancestor_rename(
        self,
    ):
        java = Folder.objects.create(
            user=self.user,
            name="Java",
            parent=self.folder,
        )
        collections = Folder.objects.create(
            user=self.user,
            name="Collections",
            parent=java,
        )
        Note.objects.filter(pk=self.note.pk).update(folder=collections)

        response = self.client.get("/api/notes/")
        returned_note = next(
            item for item in response.data if item["id"] == self.note.pk
        )

        self.assertEqual(
            returned_note["folder_path"],
            [
                {"id": self.folder.pk, "name": "Own folder"},
                {"id": java.pk, "name": "Java"},
                {"id": collections.pk, "name": "Collections"},
            ],
        )

        rename_response = self.client.patch(
            f"/api/folders/{java.pk}/",
            {"name": "Java Programming"},
            format="json",
        )

        self.assertEqual(rename_response.status_code, 200)
        refreshed_response = self.client.get("/api/notes/")
        refreshed_note = next(
            item
            for item in refreshed_response.data
            if item["id"] == self.note.pk
        )
        self.assertEqual(
            refreshed_note["folder_path"],
            [
                {"id": self.folder.pk, "name": "Own folder"},
                {"id": java.pk, "name": "Java Programming"},
                {"id": collections.pk, "name": "Collections"},
            ],
        )

    def test_folder_path_does_not_expose_foreign_owners_hierarchy(self):
        Note.objects.filter(pk=self.note.pk).update(folder=self.foreign_folder)

        response = self.client.get("/api/notes/")
        returned_note = next(
            item for item in response.data if item["id"] == self.note.pk
        )

        self.assertEqual(returned_note["folder"], self.foreign_folder.pk)
        self.assertEqual(returned_note["folder_path"], [])
        self.assertNotIn(self.foreign_folder.name, str(response.data))

    @patch("notes.views.index_note")
    def test_foreign_note_cannot_be_modified_through_patch(self, index_note):
        foreign_note = Note.objects.create(
            user=self.other_user,
            title="Private note",
            content="Private",
            note_type=Note.NoteType.STANDALONE,
            folder=self.foreign_folder,
        )

        response = self.client.patch(
            f"/api/notes/{foreign_note.pk}/",
            {"folder": self.folder.pk},
            format="json",
        )

        self.assertEqual(response.status_code, 404)
        foreign_note.refresh_from_db()
        self.assertEqual(foreign_note.folder, self.foreign_folder)
        self.assertEqual(Note.objects.filter(pk=foreign_note.pk).count(), 1)
        index_note.assert_not_called()

    @patch("notes.views.index_note")
    def test_patch_omitting_folder_preserves_existing_association(
        self,
        index_note,
    ):
        response = self.client.patch(
            f"/api/notes/{self.note.pk}/",
            {"title": "Updated title"},
            format="json",
        )

        self.assertEqual(response.status_code, 200)
        self.note.refresh_from_db()
        self.assertEqual(self.note.folder, self.folder)
        self.assertEqual(Note.objects.filter(pk=self.note.pk).count(), 1)
        index_note.assert_called_once()
