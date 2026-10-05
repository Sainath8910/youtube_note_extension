from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from folders.models import Folder
from knowledge.models import KnowledgeChunk
from knowledge.services.indexing import NoteIndexingError, index_note
from notes.models import Note
from videos.models import Video


class IndexNoteTests(TestCase):
    embedding_dimension = 1024

    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="note-indexing-user",
            password="test-password",
        )
        self.video = Video.objects.create(youtube_id="indexing-video-1")
        self.folder = Folder.objects.create(user=self.user, name="Indexing")
        self.note = Note.objects.create(
            user=self.user,
            title="Index me",
            note_type=Note.NoteType.VIDEO,
            video=self.video,
            folder=self.folder,
            document={"version": 1, "blocks": []},
        )
        self.embedding_service = Mock()
        self.embedding_service.embed_documents.side_effect = (
            self._fake_embeddings
        )
        embedding_service_patcher = patch(
            "knowledge.services.indexing.get_embedding_service",
            return_value=self.embedding_service,
        )
        self.get_embedding_service = embedding_service_patcher.start()
        self.addCleanup(embedding_service_patcher.stop)

    def _fake_embeddings(self, texts):
        return [
            [float(index + 1) / self.embedding_dimension]
            * self.embedding_dimension
            for index, _ in enumerate(texts)
        ]

    def test_empty_document_creates_no_chunks(self):
        self.assertEqual(index_note(self.note), [])
        self.assertFalse(KnowledgeChunk.objects.filter(note=self.note).exists())
        self.get_embedding_service.assert_not_called()

    def test_mixed_text_blocks_create_ordered_chunks_with_embeddings(self):
        self.note.document = {
            "version": 1,
            "blocks": [
                {"id": "h1", "type": "heading", "content": "Binary Search"},
                {
                    "id": "p1",
                    "type": "paragraph",
                    "content": "  It halves the search space.  ",
                },
                {"id": "e1", "type": "equation", "content": "O(log n)"},
                {
                    "id": "t1",
                    "type": "timestamp",
                    "content": "Each comparison halves candidates.",
                },
                {
                    "id": "img",
                    "type": "image",
                    "content": "image-url",
                    "metadata": {"alt": "Not searchable"},
                },
            ],
        }
        self.note.save(update_fields=["document"])

        chunks = index_note(self.note)

        self.assertEqual(
            [chunk.content for chunk in chunks],
            [
                "Binary Search\n\nIt halves the search space.",
                "O(log n)",
                "Each comparison halves candidates.",
            ],
        )
        self.assertEqual(
            [chunk.source_block_id for chunk in chunks],
            ["p1", "e1", "t1"],
        )
        self.assertEqual([chunk.chunk_index for chunk in chunks], [0, 1, 2])
        self.assertTrue(
            all(
                chunk.embedding is not None
                and len(chunk.embedding) == self.embedding_dimension
                for chunk in chunks
            )
        )
        self.embedding_service.embed_documents.assert_called_once_with(
            [chunk.content for chunk in chunks]
        )

    def test_text_blocks_produce_normalized_chunks_in_order(self):
        self.note.document = {
            "version": 1,
            "blocks": [
                {"id": "p1", "type": "paragraph", "content": "  First\n idea  "},
                {"id": "e1", "type": "equation", "content": " x = y "},
                {"id": "t1", "type": "timestamp", "content": "1:23"},
            ],
        }
        self.note.save(update_fields=["document"])

        chunks = index_note(self.note)

        self.assertEqual(
            [chunk.content for chunk in chunks],
            ["First\n idea", "x = y", "1:23"],
        )
        self.assertEqual(
            [chunk.source_block_id for chunk in chunks],
            ["p1", "e1", "t1"],
        )
        self.assertEqual([chunk.chunk_index for chunk in chunks], [0, 1, 2])
        self.assertTrue(all(chunk.embedding is not None for chunk in chunks))
        self.assertTrue(
            all(
                chunk.content_type == KnowledgeChunk.ContentType.NOTE_BLOCK
                for chunk in chunks
            )
        )
        self.assertTrue(
            all(
                chunk.source_type == KnowledgeChunk.SourceType.NOTE
                for chunk in chunks
            )
        )

    def test_empty_and_whitespace_blocks_are_ignored(self):
        self.note.document = {
            "version": 1,
            "blocks": [
                {"id": "empty", "type": "paragraph", "content": ""},
                {"id": "space", "type": "equation", "content": " \n\t "},
            ],
        }
        self.note.save(update_fields=["document"])

        self.assertEqual(index_note(self.note), [])
        self.get_embedding_service.assert_not_called()

    def test_source_relations_and_block_metadata_are_copied(self):
        self.note.document = {
            "version": 1,
            "blocks": [
                {"id": "p1", "type": "paragraph", "content": "A thought"},
            ],
        }
        self.note.save(update_fields=["document"])

        chunk = index_note(self.note)[0]

        self.assertEqual(chunk.user, self.user)
        self.assertEqual(chunk.note, self.note)
        self.assertEqual(chunk.video, self.video)
        self.assertEqual(chunk.folder, self.folder)
        self.assertEqual(chunk.source_block_id, "p1")
        self.assertEqual(chunk.metadata, {"block_type": "paragraph"})

    def test_heading_context_is_attached_to_the_next_text_block(self):
        self.note.document = {
            "version": 1,
            "blocks": [
                {"id": "h1", "type": "heading", "content": "  Key idea  "},
                {"id": "p1", "type": "paragraph", "content": "The explanation."},
                {"id": "h2", "type": "heading", "content": "Another section"},
                {"id": "image", "type": "image", "content": "image-url"},
            ],
        }
        self.note.save(update_fields=["document"])

        chunks = index_note(self.note)

        self.assertEqual(
            [chunk.content for chunk in chunks],
            ["Key idea\n\nThe explanation.", "Another section"],
        )
        self.assertEqual(chunks[0].source_block_id, "p1")
        self.assertEqual(
            chunks[0].metadata,
            {"block_type": "paragraph", "heading_block_id": "h1"},
        )
        self.assertEqual(chunks[1].source_block_id, "h2")

    def test_idempotency_replaces_chunks_without_accumulating_duplicates(self):
        self.note.document = {
            "version": 1,
            "blocks": [
                {"id": "p1", "type": "paragraph", "content": "Stable text"},
            ],
        }
        self.note.save(update_fields=["document"])

        first_chunks = index_note(self.note)
        first_values = [
            (
                chunk.content,
                chunk.source_block_id,
                chunk.chunk_index,
                chunk.metadata,
                list(chunk.embedding),
            )
            for chunk in first_chunks
        ]
        second_chunks = index_note(self.note)

        self.assertEqual(KnowledgeChunk.objects.filter(note=self.note).count(), 1)
        self.assertEqual(
            [
                (
                    chunk.content,
                    chunk.source_block_id,
                    chunk.chunk_index,
                    chunk.metadata,
                    list(chunk.embedding),
                )
                for chunk in second_chunks
            ],
            first_values,
        )
        self.assertNotEqual(first_chunks[0].pk, second_chunks[0].pk)
        persisted_chunk = KnowledgeChunk.objects.get(pk=second_chunks[0].pk)
        self.assertEqual(
            list(persisted_chunk.embedding),
            first_values[0][4],
        )

    def test_reindex_replaces_chunks_after_document_update(self):
        self.note.document = {
            "version": 1,
            "blocks": [
                {"id": "old", "type": "paragraph", "content": "Old content"},
            ],
        }
        self.note.save(update_fields=["document"])
        old_chunk = index_note(self.note)[0]

        self.note.document = {
            "version": 1,
            "blocks": [
                {"id": "new", "type": "paragraph", "content": "New content"},
            ],
        }
        self.note.save(update_fields=["document"])
        new_chunks = index_note(self.note)

        self.assertEqual(len(new_chunks), 1)
        self.assertEqual(new_chunks[0].content, "New content")
        self.assertEqual(new_chunks[0].source_block_id, "new")
        self.assertFalse(KnowledgeChunk.objects.filter(pk=old_chunk.pk).exists())

    def test_images_and_unknown_blocks_do_not_create_content(self):
        self.note.document = {
            "version": 1,
            "blocks": [
                {
                    "id": "image",
                    "type": "image",
                    "content": "image-url",
                    "metadata": {"alt": "Do not index this"},
                },
                {"id": "unknown", "type": "video_embed", "content": "Do not index"},
            ],
        }
        self.note.save(update_fields=["document"])

        self.assertEqual(index_note(self.note), [])
        self.get_embedding_service.assert_not_called()

    def test_empty_rebuild_removes_old_chunks_without_embedding(self):
        self.note.document = {
            "version": 1,
            "blocks": [
                {"id": "p1", "type": "paragraph", "content": "Old searchable text"},
            ],
        }
        self.note.save(update_fields=["document"])
        old_chunk = index_note(self.note)[0]
        self.embedding_service.embed_documents.reset_mock()
        self.get_embedding_service.reset_mock()

        self.note.document = {
            "version": 1,
            "blocks": [
                {"id": "image", "type": "image", "content": "image-url"},
            ],
        }
        self.note.save(update_fields=["document"])

        self.assertEqual(index_note(self.note), [])
        self.assertFalse(KnowledgeChunk.objects.filter(pk=old_chunk.pk).exists())
        self.embedding_service.embed_documents.assert_not_called()
        self.get_embedding_service.assert_not_called()

    def test_embedding_failure_preserves_existing_chunks(self):
        self.note.document = {
            "version": 1,
            "blocks": [
                {"id": "old", "type": "paragraph", "content": "Old content"},
            ],
        }
        self.note.save(update_fields=["document"])
        old_chunk = index_note(self.note)[0]

        self.note.document = {
            "version": 1,
            "blocks": [
                {"id": "new-1", "type": "paragraph", "content": "New content"},
            ],
        }
        self.note.save(update_fields=["document"])
        self.embedding_service.embed_documents.side_effect = RuntimeError(
            "Simulated embedding failure"
        )

        with self.assertRaisesRegex(RuntimeError, "Simulated embedding failure"):
            index_note(self.note)

        chunks = list(KnowledgeChunk.objects.filter(note=self.note))
        self.assertEqual([chunk.pk for chunk in chunks], [old_chunk.pk])
        self.assertEqual(chunks[0].content, "Old content")

    def test_vector_count_mismatch_preserves_existing_chunks(self):
        self.note.document = {
            "version": 1,
            "blocks": [
                {"id": "old", "type": "paragraph", "content": "Old content"},
            ],
        }
        self.note.save(update_fields=["document"])
        old_chunk = index_note(self.note)[0]

        self.note.document = {
            "version": 1,
            "blocks": [
                {"id": "new-1", "type": "paragraph", "content": "New one"},
                {"id": "new-2", "type": "equation", "content": "New two"},
            ],
        }
        self.note.save(update_fields=["document"])
        self.embedding_service.embed_documents.return_value = [
            [0.001] * self.embedding_dimension
        ]
        self.embedding_service.embed_documents.side_effect = None

        with self.assertRaisesRegex(NoteIndexingError, "1 vectors for 2"):
            index_note(self.note)

        chunks = list(KnowledgeChunk.objects.filter(note=self.note))
        self.assertEqual([chunk.pk for chunk in chunks], [old_chunk.pk])
        self.assertEqual(chunks[0].content, "Old content")

    def test_database_failure_rolls_back_partial_replacement(self):
        self.note.document = {
            "version": 1,
            "blocks": [
                {"id": "old", "type": "paragraph", "content": "Old content"},
            ],
        }
        self.note.save(update_fields=["document"])
        old_chunk = index_note(self.note)[0]

        self.note.document = {
            "version": 1,
            "blocks": [
                {"id": "new-1", "type": "paragraph", "content": "New content"},
                {"id": "new-2", "type": "paragraph", "content": "New content 2"},
            ],
        }
        self.note.save(update_fields=["document"])
        original_bulk_create = KnowledgeChunk.objects.bulk_create

        def insert_one_then_fail(chunks, **kwargs):
            original_bulk_create(chunks[:1], **kwargs)
            raise RuntimeError("Simulated database failure")

        with patch.object(
            KnowledgeChunk.objects,
            "bulk_create",
            side_effect=insert_one_then_fail,
        ):
            with self.assertRaisesRegex(RuntimeError, "Simulated database failure"):
                index_note(self.note)

        chunks = list(KnowledgeChunk.objects.filter(note=self.note))
        self.assertEqual([chunk.pk for chunk in chunks], [old_chunk.pk])
        self.assertEqual(chunks[0].content, "Old content")
