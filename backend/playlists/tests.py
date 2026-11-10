from unittest.mock import patch

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from playlists.models import Playlist
from playlists.services import add_video_to_youtube_playlist
from videos.models import Video, ViewingSession


class PlaylistApiTests(APITestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="playlist-user",
            password="test-password",
        )
        self.client.force_authenticate(self.user)

    def test_creating_the_same_youtube_playlist_is_idempotent(self):
        playlist_data = {
            "kind": "YOUTUBE",
            "title": "Learning path",
            "channel_name": "Learning",
            "youtube_playlist_id": "PL_123",
            "thumbnail_url": "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
            "playlist_url": "https://www.youtube.com/playlist?list=PL_123",
        }
        first = self.client.post("/api/playlists/", playlist_data, format="json")
        repeated = self.client.post("/api/playlists/", playlist_data, format="json")
        self.assertEqual(first.status_code, 201, first.data)
        self.assertEqual(repeated.status_code, 201, repeated.data)
        self.assertEqual(first.data["id"], repeated.data["id"])
        self.assertEqual(self.client.get("/api/playlists/").data["count"], 1)

    def test_playlist_title_can_be_edited(self):
        created = self.client.post(
            "/api/playlists/",
            {
                "kind": "YOUTUBE",
                "title": "Untitled YouTube playlist",
                "youtube_playlist_id": "PL_123",
            },
            format="json",
        )
        self.assertEqual(created.status_code, 201, created.data)

        updated = self.client.patch(
            f"/api/playlists/{created.data['id']}/",
            {"title": "Algorithms and data structures"},
            format="json",
        )

        self.assertEqual(updated.status_code, 200, updated.data)
        self.assertEqual(updated.data["title"], "Algorithms and data structures")

    def test_playlist_cover_can_be_edited_and_cleared(self):
        created = self.client.post(
            "/api/playlists/",
            {"kind": "CUSTOM", "title": "Learning"},
            format="json",
        )
        playlist_url = f"/api/playlists/{created.data['id']}/"
        image_url = "https://example.com/learning-cover.jpg"

        updated = self.client.patch(
            playlist_url,
            {"thumbnail_url": image_url},
            format="json",
        )
        self.assertEqual(updated.status_code, 200, updated.data)
        self.assertEqual(updated.data["thumbnail_url"], image_url)

        cleared = self.client.patch(
            playlist_url,
            {"thumbnail_url": ""},
            format="json",
        )
        self.assertEqual(cleared.status_code, 200, cleared.data)
        self.assertEqual(cleared.data["thumbnail_url"], "")

    def test_video_library_can_filter_playlist_membership(self):
        playlist = Playlist.objects.create(
            user=self.user,
            kind=Playlist.Kind.CUSTOM,
            title="Learning",
        )
        in_video = Video.objects.create(
            youtube_id="aaaaaaaaaaa",
            title="In playlist",
        )
        out_video = Video.objects.create(
            youtube_id="bbbbbbbbbbb",
            title="Not in playlist",
        )
        playlist.items.create(video=in_video, position=0)
        ViewingSession.objects.create(user=self.user, video=out_video)

        in_response = self.client.get(
            f"/api/videos/?playlist_filter=in_playlist&playlist_id={playlist.pk}"
        )
        out_response = self.client.get(
            f"/api/videos/?playlist_filter=not_in_playlist&playlist_id={playlist.pk}"
        )

        self.assertEqual(in_response.status_code, 200, in_response.data)
        self.assertEqual(
            [video["youtube_id"] for video in in_response.data["results"]],
            ["aaaaaaaaaaa"],
        )
        self.assertEqual(out_response.status_code, 200, out_response.data)
        self.assertEqual(
            [video["youtube_id"] for video in out_response.data["results"]],
            ["bbbbbbbbbbb"],
        )

    def test_import_placeholder_does_not_replace_a_customized_youtube_title(self):
        playlist = Playlist.objects.create(
            user=self.user,
            kind=Playlist.Kind.YOUTUBE,
            title="My renamed playlist",
            youtube_playlist_id="PL_renamed",
        )
        video = Video.objects.create(
            youtube_id="abcdefghijk",
            title="A video",
        )

        add_video_to_youtube_playlist(
            user=self.user,
            video=video,
            playlist_id=playlist.youtube_playlist_id,
            title="Untitled YouTube playlist",
        )

        playlist.refresh_from_db()
        self.assertEqual(playlist.title, "My renamed playlist")

    def test_custom_playlist_membership_trash_restore_keeps_video(self):
        response = self.client.post(
            "/api/playlists/",
            {"kind": "CUSTOM", "title": "Algorithms"},
            format="json",
        )
        self.assertEqual(response.status_code, 201)
        video_library = self.client.get("/api/videos/")
        self.assertEqual(video_library.status_code, 200)
        self.assertEqual(video_library.data["count"], 0)
        playlist_id = response.data["id"]
        self.assertEqual(response.data["videos_count"], 0)

        response = self.client.post(
            f"/api/playlists/{playlist_id}/videos/",
            {
                "youtube_id": "abcdefghijk",
                "title": "Binary search",
                "channel_name": "Learning",
                "thumbnail_url": "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201)

        response = self.client.delete(
            f"/api/playlists/{playlist_id}/videos/abcdefghijk/"
        )
        self.assertEqual(response.status_code, 204)
        self.assertTrue(Video.objects.filter(youtube_id="abcdefghijk").exists())

        self.client.post(
            f"/api/playlists/{playlist_id}/videos/",
            {"youtube_id": "abcdefghijk"},
            format="json",
        )
        self.client.delete(f"/api/playlists/{playlist_id}/")
        trash = self.client.get("/api/notes/trash/")
        self.assertEqual(trash.status_code, 200)
        self.assertTrue(any(
            item["entity"] == "playlist" and item["id"] == playlist_id
            for item in trash.data["items"]
        ))

        response = self.client.post(
            f"/api/notes/trash/playlist/{playlist_id}/restore/",
            {},
            format="json",
        )
        self.assertEqual(response.status_code, 200)
        detail = self.client.get(f"/api/playlists/{playlist_id}/")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(
            [item["youtube_id"] for item in detail.data["videos"]],
            ["abcdefghijk"],
        )
        self.assertTrue(Video.objects.filter(youtube_id="abcdefghijk").exists())

    @patch(
        "notes.views.fetch_youtube_metadata",
        return_value={
            "title": "Binary search",
            "channel_name": "Learning",
            "channel_handle": "",
            "channel_id": "",
            "thumbnail_url": "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
            "duration_seconds": None,
        },
    )
    def test_saving_a_note_from_youtube_playlist_creates_membership(self, _metadata):
        response = self.client.post(
            "/api/notes/video/",
            {
                "youtube_id": "abcdefghijk",
                "title": "Binary search notes",
                "content": "Notes",
                "document": {"version": 1, "blocks": []},
                "note_type": "VIDEO",
                "timestamp_seconds": None,
                "youtube_playlist_id": "PL_123",
                "youtube_playlist_title": "Algorithms",
                "youtube_playlist_thumbnail_url": "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        detail = self.client.get("/api/playlists/")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(len(detail.data["results"]), 1)
        self.assertEqual(detail.data["results"][0]["youtube_playlist_id"], "PL_123")
        self.assertEqual(detail.data["results"][0]["videos_count"], 1)

    @patch(
        "notes.views.fetch_youtube_metadata",
        return_value={
            "title": "Current lesson",
            "channel_name": "Learning",
            "channel_handle": "",
            "channel_id": "",
            "thumbnail_url": "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
            "duration_seconds": None,
        },
    )
    def test_imported_youtube_playlist_videos_keep_order_and_unwatched_stay_hidden(
        self, _metadata
    ):
        response = self.client.post(
            "/api/notes/video/",
            {
                "youtube_id": "abcdefghijk",
                "title": "Current lesson notes",
                "content": "Notes",
                "document": {"version": 1, "blocks": []},
                "note_type": "VIDEO",
                "timestamp_seconds": None,
                "youtube_playlist_id": "PL_ordered",
                "youtube_playlist_title": "Ordered playlist",
                "youtube_playlist_channel_name": "Learning",
                "youtube_playlist_videos": [
                    {
                        "youtube_id": "aaaaaaaaaaa",
                        "title": "First lesson",
                        "channel_name": "Learning",
                        "thumbnail_url": "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg",
                        "position": 0,
                    },
                    {
                        "youtube_id": "abcdefghijk",
                        "title": "Current lesson",
                        "channel_name": "Learning",
                        "thumbnail_url": "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
                        "position": 1,
                    },
                    {
                        "youtube_id": "bbbbbbbbbbb",
                        "title": "Next lesson",
                        "channel_name": "Learning",
                        "thumbnail_url": "https://i.ytimg.com/vi/bbbbbbbbbbb/hqdefault.jpg",
                        "position": 2,
                    },
                ],
                "youtube_playlist_current_position": 1,
            },
            format="json",
        )
        self.assertEqual(response.status_code, 201, response.data)
        playlist = self.client.get("/api/playlists/?q=Ordered&kind=YOUTUBE")
        self.assertEqual(playlist.status_code, 200)
        self.assertEqual(playlist.data["count"], 1)
        playlist_id = playlist.data["results"][0]["id"]
        details = self.client.get(f"/api/playlists/{playlist_id}/")
        self.assertEqual(
            [item["youtube_id"] for item in details.data["videos"]],
            ["aaaaaaaaaaa", "abcdefghijk", "bbbbbbbbbbb"],
        )
        unseen_video = self.client.get("/api/videos/aaaaaaaaaaa/details/")
        self.assertEqual(unseen_video.status_code, 200, unseen_video.data)
        self.assertEqual(unseen_video.data["video"]["notes_count"], 0)
        transcript = self.client.get("/api/videos/aaaaaaaaaaa/transcript/")
        self.assertEqual(transcript.status_code, 200, transcript.data)
        analysis = self.client.get("/api/videos/aaaaaaaaaaa/analyze/")
        self.assertEqual(analysis.status_code, 200, analysis.data)
        video_library = self.client.get("/api/videos/")
        self.assertEqual(
            [item["youtube_id"] for item in video_library.data["results"]],
            ["abcdefghijk"],
        )
