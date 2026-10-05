from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from knowledge.models import KnowledgeChunk
from knowledge.services.embeddings import EmbeddingInferenceError
from knowledge.services.transcript_indexing import (
    TARGET_CHUNK_CHARACTERS,
    TranscriptIndexingError,
    TranscriptNotReadyError,
    index_video_transcript,
)
from videos.models import Video


class IndexVideoTranscriptTests(TestCase):
    embedding_dimension = 1024

    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="transcript-indexing-user",
        )
        self.other_user = get_user_model().objects.create_user(
            username="other-transcript-indexing-user",
        )
        self.video = Video.objects.create(
            youtube_id="transcript-index-1",
            transcript_status=Video.TranscriptStatus.READY,
            transcript=[
                {"text": "  First transcript segment.  ", "start": 1.25, "duration": 2.5},
                {"text": "Second transcript segment.", "start": 3.75, "duration": 2},
            ],
        )
        self.embedding_service = Mock()
        self.embedding_service.embed_documents.side_effect = (
            self._fake_embeddings
        )
        patcher = patch(
            "knowledge.services.transcript_indexing.get_embedding_service",
            return_value=self.embedding_service,
        )
        self.get_embedding_service = patcher.start()
        self.addCleanup(patcher.stop)

    def _fake_embeddings(self, texts):
        return [
            [float(index + 1) / self.embedding_dimension]
            * self.embedding_dimension
            for index, _ in enumerate(texts)
        ]

    def test_indexes_ready_transcript_with_timestamps_and_ownership(self):
        chunks = index_video_transcript(video=self.video, user=self.user)

        self.assertEqual(len(chunks), 1)
        chunk = chunks[0]
        self.assertEqual(
            chunk.content,
            "First transcript segment.\nSecond transcript segment.",
        )
        self.assertEqual(chunk.source_type, KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT)
        self.assertEqual(
            chunk.content_type,
            KnowledgeChunk.ContentType.TRANSCRIPT_CHUNK,
        )
        self.assertEqual(chunk.video, self.video)
        self.assertEqual(chunk.user, self.user)
        self.assertIsNone(chunk.note)
        self.assertIsNone(chunk.folder)
        self.assertIsNone(chunk.source_block_id)
        self.assertEqual(chunk.chunk_index, 0)
        self.assertEqual(
            chunk.metadata,
            {
                "source_type": KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
                "start_seconds": 1.25,
                "end_seconds": 5.75,
            },
        )
        self.assertEqual(len(chunk.embedding), self.embedding_dimension)
        self.embedding_service.embed_documents.assert_called_once_with(
            [chunk.content]
        )

    def test_chunks_remain_in_transcript_order(self):
        self.video.transcript = [
            {"text": "A" * 999, "start": 0, "duration": 1},
            {"text": "B" * 999, "start": 1, "duration": 1},
            {"text": "C" * 999, "start": 2, "duration": 1},
        ]

        chunks = index_video_transcript(video=self.video, user=self.user)

        self.assertEqual([chunk.chunk_index for chunk in chunks], [0, 1])
        self.assertTrue(chunks[0].content.startswith("A" * 999))
        self.assertIn("B" * 999, chunks[0].content)
        self.assertEqual(chunks[1].content, "C" * 999)
        self.assertEqual(
            [chunk.metadata["start_seconds"] for chunk in chunks],
            [0.0, 2.0],
        )
        self.assertEqual(
            [chunk.metadata["end_seconds"] for chunk in chunks],
            [2.0, 3.0],
        )

    def test_empty_transcript_preserves_existing_chunks_and_skips_embedding(self):
        existing_chunk = index_video_transcript(
            video=self.video,
            user=self.user,
        )[0]
        self.embedding_service.embed_documents.reset_mock()
        self.get_embedding_service.reset_mock()
        self.video.transcript = [
            {"text": " \n ", "start": 0, "duration": 1},
            {"text": "", "start": 1, "duration": 1},
        ]

        result = index_video_transcript(video=self.video, user=self.user)

        self.assertEqual(result, [])
        self.assertEqual(
            list(
                KnowledgeChunk.objects.filter(
                    user=self.user,
                    video=self.video,
                    source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
                )
            ),
            [existing_chunk],
        )
        self.get_embedding_service.assert_not_called()
        self.embedding_service.embed_documents.assert_not_called()

    def test_missing_transcript_preserves_existing_chunks(self):
        existing_chunk = index_video_transcript(
            video=self.video,
            user=self.user,
        )[0]
        self.embedding_service.embed_documents.reset_mock()
        self.get_embedding_service.reset_mock()
        self.video.transcript = None

        self.assertEqual(
            index_video_transcript(video=self.video, user=self.user),
            [],
        )

        self.assertTrue(
            KnowledgeChunk.objects.filter(pk=existing_chunk.pk).exists()
        )
        self.get_embedding_service.assert_not_called()

    def test_non_ready_transcript_is_rejected_without_replacing_chunks(self):
        existing_chunk = index_video_transcript(
            video=self.video,
            user=self.user,
        )[0]
        self.embedding_service.embed_documents.reset_mock()
        self.video.transcript_status = Video.TranscriptStatus.FETCHING

        with self.assertRaises(TranscriptNotReadyError):
            index_video_transcript(video=self.video, user=self.user)

        self.assertTrue(
            KnowledgeChunk.objects.filter(pk=existing_chunk.pk).exists()
        )
        self.embedding_service.embed_documents.assert_not_called()

    def test_repeated_indexing_replaces_without_duplicates(self):
        first_chunks = index_video_transcript(video=self.video, user=self.user)
        first_values = [
            (chunk.content, chunk.chunk_index, chunk.metadata)
            for chunk in first_chunks
        ]

        second_chunks = index_video_transcript(video=self.video, user=self.user)

        self.assertEqual(
            KnowledgeChunk.objects.filter(
                user=self.user,
                video=self.video,
                source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
            ).count(),
            len(first_chunks),
        )
        self.assertEqual(
            [
                (chunk.content, chunk.chunk_index, chunk.metadata)
                for chunk in second_chunks
            ],
            first_values,
        )
        self.assertNotEqual(first_chunks[0].pk, second_chunks[0].pk)

    def test_changed_transcript_replaces_old_chunks(self):
        old_chunk = index_video_transcript(
            video=self.video,
            user=self.user,
        )[0]
        self.video.transcript = [
            {"text": "Updated transcript only.", "start": 20, "duration": 4},
        ]

        chunks = index_video_transcript(video=self.video, user=self.user)

        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].content, "Updated transcript only.")
        self.assertFalse(KnowledgeChunk.objects.filter(pk=old_chunk.pk).exists())

    def test_reindexing_one_user_preserves_other_users_chunks(self):
        other_chunks = index_video_transcript(
            video=self.video,
            user=self.other_user,
        )
        original_other = [
            (chunk.pk, chunk.content, list(chunk.embedding))
            for chunk in other_chunks
        ]
        index_video_transcript(video=self.video, user=self.user)
        self.video.transcript = [
            {"text": "Updated for first user.", "start": 30, "duration": 5},
        ]

        index_video_transcript(video=self.video, user=self.user)

        self.assertEqual(
            [
                (chunk.pk, chunk.content, list(chunk.embedding))
                for chunk in KnowledgeChunk.objects.filter(
                    user=self.other_user,
                    video=self.video,
                    source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
                )
            ],
            original_other,
        )

    def test_embedding_failure_preserves_existing_transcript_chunks(self):
        existing_chunk = index_video_transcript(
            video=self.video,
            user=self.user,
        )[0]
        self.video.transcript = [
            {"text": "Replacement transcript.", "start": 10, "duration": 2},
        ]
        self.embedding_service.embed_documents.side_effect = (
            EmbeddingInferenceError("embedding failed")
        )

        with self.assertRaises(TranscriptIndexingError):
            index_video_transcript(video=self.video, user=self.user)

        chunks = list(
            KnowledgeChunk.objects.filter(
                user=self.user,
                video=self.video,
                source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
            )
        )
        self.assertEqual([chunk.pk for chunk in chunks], [existing_chunk.pk])
        self.assertEqual(chunks[0].content, existing_chunk.content)

    def test_embedding_count_mismatch_preserves_existing_chunks(self):
        existing_chunk = index_video_transcript(
            video=self.video,
            user=self.user,
        )[0]
        self.video.transcript = [
            {
                "text": "A" * TARGET_CHUNK_CHARACTERS,
                "start": 0,
                "duration": 1,
            },
            {
                "text": "B" * TARGET_CHUNK_CHARACTERS,
                "start": 1,
                "duration": 1,
            },
        ]
        self.embedding_service.embed_documents.side_effect = None
        self.embedding_service.embed_documents.return_value = [
            [0.1] * self.embedding_dimension
        ]

        with self.assertRaisesRegex(TranscriptIndexingError, "1 vectors for 2"):
            index_video_transcript(video=self.video, user=self.user)

        self.assertTrue(
            KnowledgeChunk.objects.filter(pk=existing_chunk.pk).exists()
        )

    def test_embedding_dimension_mismatch_preserves_existing_chunks(self):
        existing_chunk = index_video_transcript(
            video=self.video,
            user=self.user,
        )[0]
        self.video.transcript = [
            {"text": "Replacement transcript.", "start": 10, "duration": 2},
        ]
        self.embedding_service.embed_documents.side_effect = None
        self.embedding_service.embed_documents.return_value = [[0.1, 0.2]]

        with self.assertRaisesRegex(
            TranscriptIndexingError,
            "dimension 2; expected 1024",
        ):
            index_video_transcript(video=self.video, user=self.user)

        self.assertTrue(
            KnowledgeChunk.objects.filter(pk=existing_chunk.pk).exists()
        )

    def test_large_single_segment_is_not_truncated_or_discarded(self):
        long_text = "Large segment. " * 400
        self.video.transcript = [
            {"text": long_text, "start": 5, "duration": 60},
        ]

        chunks = index_video_transcript(video=self.video, user=self.user)

        self.assertEqual(len(chunks), 1)
        self.assertEqual(chunks[0].content, long_text.strip())
