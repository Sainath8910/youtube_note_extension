from io import StringIO
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.core.management import call_command, CommandError
from django.test import TestCase
from rest_framework.test import APIClient

from folders.models import Folder
from knowledge.models import KnowledgeChunk
from notes.models import Note
from videos.models import Video
from videos.services.youtube import YouTubeMetadataError


class NoteIndexingIntegrationTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="note-index-integration",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.video = Video.objects.create(youtube_id="integration001")
        self.folder = Folder.objects.create(
            user=self.user,
            name="Integration folder",
        )
        self.embedding_service = Mock()
        self.embedding_service.embed_documents.side_effect = (
            self.fake_embeddings
        )
        patcher = patch(
            "knowledge.services.indexing.get_embedding_service",
            return_value=self.embedding_service,
        )
        self.get_embedding_service = patcher.start()
        self.addCleanup(patcher.stop)

    @staticmethod
    def fake_embeddings(texts):
        return [[0.01] * 1024 for _ in texts]

    @staticmethod
    def make_document(*blocks):
        return {"version": 1, "blocks": list(blocks)}

    def create_video_note(self, *, content="Initial video note content"):
        with patch(
            "notes.views.fetch_youtube_metadata",
            side_effect=YouTubeMetadataError("metadata unavailable"),
        ):
            return self.client.post(
                "/api/notes/video/",
                {
                    "youtube_id": self.video.youtube_id,
                    "title": "Video note",
                    "content": content,
                    "document": self.make_document({
                        "id": "paragraph-1",
                        "type": "paragraph",
                        "content": content,
                    }),
                    "note_type": Note.NoteType.VIDEO,
                    "timestamp_seconds": None,
                    "folder": self.folder.pk,
                },
                format="json",
            )

    def test_video_note_create_indexes_after_persisting_note(self):
        response = self.create_video_note()

        self.assertEqual(response.status_code, 201)
        note = Note.objects.get(pk=response.data["note"]["id"])
        chunk = KnowledgeChunk.objects.get(note=note)
        self.assertEqual(chunk.content, "Initial video note content")
        self.assertEqual(chunk.user, self.user)
        self.assertEqual(chunk.video, self.video)
        self.assertEqual(chunk.folder, self.folder)
        self.assertIsNotNone(chunk.embedding)

    def test_standalone_note_create_indexes_through_generic_create_path(self):
        response = self.client.post(
            "/api/notes/",
            {
                "title": "Standalone",
                "content": "Standalone searchable content",
                "document": self.make_document({
                    "id": "standalone-block",
                    "type": "paragraph",
                    "content": "Standalone searchable content",
                }),
                "note_type": Note.NoteType.STANDALONE,
                "folder": self.folder.pk,
            },
            format="json",
        )

        self.assertEqual(response.status_code, 201)
        note = Note.objects.get(pk=response.data["id"])
        chunk = KnowledgeChunk.objects.get(note=note)
        self.assertEqual(chunk.content, "Standalone searchable content")
        self.assertIsNone(chunk.video)
        self.assertEqual(chunk.folder, self.folder)

    def test_update_replaces_old_chunks_with_current_document(self):
        response = self.create_video_note()
        self.assertEqual(response.status_code, 201)
        note_id = response.data["note"]["id"]

        update_response = self.client.patch(
            f"/api/notes/{note_id}/",
            {
                "document": self.make_document(
                    {
                        "id": "new-block-1",
                        "type": "paragraph",
                        "content": "Updated searchable content",
                    },
                    {
                        "id": "new-block-2",
                        "type": "equation",
                        "content": "O(log n)",
                    },
                ),
                "content": "Updated searchable content\n\nO(log n)",
            },
            format="json",
        )

        self.assertEqual(update_response.status_code, 200)
        chunks = list(
            KnowledgeChunk.objects.filter(note_id=note_id).order_by("chunk_index")
        )
        self.assertEqual(
            [chunk.content for chunk in chunks],
            ["Updated searchable content", "O(log n)"],
        )
        self.assertEqual([chunk.chunk_index for chunk in chunks], [0, 1])
        self.assertEqual(len({chunk.pk for chunk in chunks}), 2)

        self.client.patch(
            f"/api/notes/{note_id}/",
            {
                "document": self.make_document({
                    "id": "new-block-1",
                    "type": "paragraph",
                    "content": "Updated searchable content",
                }),
                "content": "Updated searchable content",
            },
            format="json",
        )
        self.assertEqual(
            KnowledgeChunk.objects.filter(note_id=note_id).count(),
            1,
        )

    def test_indexing_failure_rolls_back_note_create_and_returns_error(self):
        self.embedding_service.embed_documents.side_effect = RuntimeError(
            "embedding failure detail"
        )

        response = self.create_video_note()

        self.assertEqual(response.status_code, 502)
        self.assertNotIn("embedding failure detail", str(response.data))
        self.assertFalse(Note.objects.filter(title="Video note").exists())
        self.assertFalse(KnowledgeChunk.objects.filter(user=self.user).exists())

    def test_indexing_failure_rolls_back_note_update_and_keeps_previous_chunks(self):
        response = self.create_video_note()
        self.assertEqual(response.status_code, 201)
        note_id = response.data["note"]["id"]
        old_chunks = list(KnowledgeChunk.objects.filter(note_id=note_id))
        self.embedding_service.embed_documents.side_effect = RuntimeError(
            "embedding failure detail"
        )

        update_response = self.client.patch(
            f"/api/notes/{note_id}/",
            {
                "document": self.make_document({
                    "id": "replacement",
                    "type": "paragraph",
                    "content": "Replacement content",
                }),
                "content": "Replacement content",
            },
            format="json",
        )

        self.assertEqual(update_response.status_code, 502)
        note = Note.objects.get(pk=note_id)
        self.assertEqual(
            note.document["blocks"][0]["content"],
            "Initial video note content",
        )
        current_chunks = list(KnowledgeChunk.objects.filter(note=note))
        self.assertEqual(
            [chunk.pk for chunk in current_chunks],
            [chunk.pk for chunk in old_chunks],
        )
        self.assertEqual(current_chunks[0].content, "Initial video note content")

    def create_standalone_note(self, username, text):
        user = get_user_model().objects.get(username=username)
        return Note.objects.create(
            user=user,
            title=f"Note {text}",
            note_type=Note.NoteType.STANDALONE,
            content=text,
            document=self.make_document({
                "id": f"block-{text}",
                "type": "paragraph",
                "content": text,
            }),
        )

    def test_index_notes_command_is_repeatable_without_duplicate_chunks(self):
        self.create_standalone_note(
            "note-index-integration",
            "Backfill first note",
        )
        self.create_standalone_note(
            "note-index-integration",
            "Backfill second note",
        )
        first_output = StringIO()
        call_command("index_notes", stdout=first_output)
        first_count = KnowledgeChunk.objects.count()

        second_output = StringIO()
        call_command("index_notes", stdout=second_output)

        self.assertGreater(first_count, 0)
        self.assertEqual(KnowledgeChunk.objects.count(), first_count)
        self.assertIn("Indexing", first_output.getvalue())
        self.assertIn("Completed:", first_output.getvalue())
        self.assertIn("0 failed", second_output.getvalue())

    def test_index_notes_command_continues_and_fails_if_any_note_fails(self):
        self.create_standalone_note(
            "note-index-integration",
            "Command first",
        )
        self.create_standalone_note(
            "note-index-integration",
            "Command second",
        )
        output = StringIO()
        error_output = StringIO()

        with patch(
            "knowledge.management.commands.index_notes.index_note",
            side_effect=[RuntimeError("failure"), []],
        ) as index:
            with self.assertRaises(CommandError):
                call_command(
                    "index_notes",
                    stdout=output,
                    stderr=error_output,
                )

        self.assertEqual(index.call_count, 2)
        self.assertIn("1 failed", output.getvalue())
        self.assertIn("Failed note", error_output.getvalue())
