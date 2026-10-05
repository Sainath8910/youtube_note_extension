from django.contrib.auth import get_user_model
from django.core.exceptions import ValidationError
from django.db import DataError
from django.test import TestCase

from folders.models import Folder
from knowledge.models import KnowledgeChunk
from notes.models import Note
from videos.models import Video


class KnowledgeChunkModelTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="knowledge-chunk-user",
            password="test-password",
        )

    def test_create_note_chunk_with_required_content(self):
        chunk = KnowledgeChunk.objects.create(
            user=self.user,
            content="A searchable note",
            content_type=KnowledgeChunk.ContentType.NOTE,
        )

        self.assertEqual(chunk.content, "A searchable note")
        self.assertEqual(chunk.content_type, "NOTE")
        self.assertEqual(chunk.chunk_index, 0)
        self.assertEqual(chunk.user, self.user)
        self.assertEqual(self.user.knowledge_chunks.get(), chunk)
        self.assertIsNone(chunk.embedding)

    def test_embedding_vector_persists_with_1024_dimensions(self):
        expected_embedding = [index / 1024 for index in range(1024)]
        chunk = KnowledgeChunk.objects.create(
            user=self.user,
            content="Vector persistence test",
            content_type=KnowledgeChunk.ContentType.NOTE,
            embedding=expected_embedding,
        )

        reloaded_chunk = KnowledgeChunk.objects.get(pk=chunk.pk)

        self.assertEqual(len(reloaded_chunk.embedding), 1024)
        self.assertEqual(reloaded_chunk.embedding.tolist(), expected_embedding)

    def test_embedding_with_wrong_dimension_is_rejected_by_database(self):
        with self.assertRaises(DataError):
            KnowledgeChunk.objects.create(
                user=self.user,
                content="Invalid vector dimensions",
                content_type=KnowledgeChunk.ContentType.NOTE,
                embedding=[0.1, 0.2],
            )

    def test_create_chunk_with_optional_note_video_and_folder(self):
        video = Video.objects.create(youtube_id="chunk-video-01")
        folder = Folder.objects.create(user=self.user, name="Study")
        note = Note.objects.create(
            user=self.user,
            title="Source note",
            note_type=Note.NoteType.VIDEO,
            video=video,
            folder=folder,
        )

        chunk = KnowledgeChunk.objects.create(
            user=self.user,
            note=note,
            video=video,
            folder=folder,
            content="A searchable note block",
            content_type=KnowledgeChunk.ContentType.NOTE_BLOCK,
            source_block_id="block-1",
            chunk_index=2,
            metadata={"heading": "Key idea", "position": 1},
        )

        self.assertEqual(chunk.note, note)
        self.assertEqual(chunk.video, video)
        self.assertEqual(chunk.folder, folder)
        self.assertEqual(chunk.source_block_id, "block-1")
        self.assertEqual(chunk.chunk_index, 2)
        self.assertEqual(chunk.metadata, {"heading": "Key idea", "position": 1})
        self.assertEqual(note.knowledge_chunks.get(), chunk)
        self.assertEqual(video.knowledge_chunks.get(), chunk)
        self.assertEqual(folder.knowledge_chunks.get(), chunk)

    def test_relationships_can_be_null(self):
        chunk = KnowledgeChunk.objects.create(
            user=self.user,
            note=None,
            video=None,
            folder=None,
            content="Standalone searchable knowledge",
            content_type=KnowledgeChunk.ContentType.NOTE,
        )

        self.assertIsNone(chunk.note)
        self.assertIsNone(chunk.video)
        self.assertIsNone(chunk.folder)

    def test_content_type_choices_are_validated(self):
        for content_type in KnowledgeChunk.ContentType.values:
            with self.subTest(content_type=content_type):
                chunk = KnowledgeChunk(
                    user=self.user,
                    content="Valid source type",
                    content_type=content_type,
                    metadata={"source": "note"},
                )
                chunk.full_clean()

        invalid_chunk = KnowledgeChunk(
            user=self.user,
            content="Unsupported source type",
            content_type="TRANSCRIPT",
        )
        with self.assertRaises(ValidationError):
            invalid_chunk.full_clean()

    def test_duplicate_chunks_are_allowed(self):
        values = {
            "user": self.user,
            "content": "Repeated content",
            "content_type": KnowledgeChunk.ContentType.NOTE,
        }

        first = KnowledgeChunk.objects.create(**values)
        second = KnowledgeChunk.objects.create(**values)

        self.assertNotEqual(first.pk, second.pk)
