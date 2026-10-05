from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from knowledge.models import KnowledgeChunk
from knowledge.services.analysis_indexing import (
    VideoAnalysisIndexingError,
    index_video_analysis,
)
from knowledge.services.embeddings import EmbeddingInferenceError
from videos.models import Video, VideoAnalysis


class IndexVideoAnalysisTests(TestCase):
    embedding_dimension = 1024

    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="analysis-indexing-user",
        )
        self.other_user = get_user_model().objects.create_user(
            username="other-analysis-indexing-user",
        )
        self.video = Video.objects.create(youtube_id="analysis-index-1")
        self.analysis = VideoAnalysis.objects.create(
            video=self.video,
            summary="Binary search halves the search interval.",
            detailed_notes={
                "sections": [
                    {
                        "heading": "Search invariant",
                        "content": "The target remains in the active interval.",
                    }
                ],
                "definitions": ["A sorted sequence is ordered by key."],
                "examples": ["Search a sorted list of numbers."],
            },
            topics=["Searching"],
            concepts=[
                {
                    "concept": "Binary search",
                    "definition": "Repeatedly halve a sorted search interval.",
                }
            ],
            prerequisites=["Sorted input"],
            upcoming_topics=["Search trees"],
            key_points=[{"text": "Each step halves the interval.", "start": 12.5}],
            claims=[{"text": "The time is logarithmic.", "start": 15.0}],
            questions=["Why must the input be sorted?"],
        )
        self.embedding_service = Mock()
        self.embedding_service.embed_documents.side_effect = (
            self._fake_embeddings
        )
        patcher = patch(
            "knowledge.services.analysis_indexing.get_embedding_service",
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

    def test_indexes_all_analysis_sections_with_source_metadata(self):
        chunks = index_video_analysis(video=self.video, user=self.user)

        self.assertGreater(len(chunks), 1)
        self.assertTrue(
            all(
                chunk.source_type == KnowledgeChunk.SourceType.VIDEO_ANALYSIS
                and chunk.content_type
                == KnowledgeChunk.ContentType.ANALYSIS_CHUNK
                and chunk.video == self.video
                and chunk.user == self.user
                and chunk.note is None
                and chunk.folder is None
                and chunk.embedding is not None
                and len(chunk.embedding) == self.embedding_dimension
                for chunk in chunks
            )
        )
        self.assertEqual(
            [chunk.chunk_index for chunk in chunks],
            list(range(len(chunks))),
        )
        self.assertEqual(
            {chunk.metadata["section"] for chunk in chunks},
            {
                "summary",
                "detailed_notes",
                "topics",
                "concepts",
                "prerequisites",
                "upcoming_topics",
                "key_points",
                "claims",
                "questions",
            },
        )
        detailed_chunk = next(
            chunk
            for chunk in chunks
            if chunk.metadata["section"] == "detailed_notes"
            and chunk.metadata["subsection"] == "sections"
        )
        self.assertIn("Search invariant", detailed_chunk.content)
        self.assertIn(
            "The target remains in the active interval.",
            detailed_chunk.content,
        )
        concept_chunk = next(
            chunk
            for chunk in chunks
            if chunk.metadata["section"] == "concepts"
        )
        self.assertIn("Concept: Binary search", concept_chunk.content)
        self.assertIn("Definition:", concept_chunk.content)
        self.assertIn("(at 12.5s)", next(
            chunk.content
            for chunk in chunks
            if chunk.metadata["section"] == "key_points"
        ))
        self.embedding_service.embed_documents.assert_called_once_with(
            [chunk.content for chunk in chunks]
        )

    def test_empty_analysis_does_not_embed_or_delete_existing_chunks(self):
        original = index_video_analysis(video=self.video, user=self.user)
        self.analysis.summary = ""
        self.analysis.detailed_notes = {}
        for field in (
            "topics",
            "concepts",
            "prerequisites",
            "upcoming_topics",
            "key_points",
            "claims",
            "questions",
        ):
            setattr(self.analysis, field, [])
        self.analysis.save()
        self.embedding_service.embed_documents.reset_mock()
        self.get_embedding_service.reset_mock()

        self.assertEqual(
            index_video_analysis(video=self.video, user=self.user),
            [],
        )
        self.assertEqual(
            list(
                KnowledgeChunk.objects.filter(
                    user=self.user,
                    video=self.video,
                    source_type=KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
                )
            ),
            original,
        )
        self.get_embedding_service.assert_not_called()

    def test_missing_analysis_does_not_embed(self):
        video_without_analysis = Video.objects.create(
            youtube_id="analysis-index-empty"
        )

        self.assertEqual(
            index_video_analysis(video=video_without_analysis, user=self.user),
            [],
        )
        self.get_embedding_service.assert_not_called()

    def test_repeated_indexing_is_idempotent(self):
        first = index_video_analysis(video=self.video, user=self.user)
        second = index_video_analysis(video=self.video, user=self.user)

        self.assertEqual(len(second), len(first))
        self.assertNotEqual(first[0].pk, second[0].pk)
        self.assertEqual(
            KnowledgeChunk.objects.filter(
                user=self.user,
                video=self.video,
                source_type=KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
            ).count(),
            len(first),
        )
        self.assertEqual(
            [(chunk.content, chunk.metadata) for chunk in first],
            [(chunk.content, chunk.metadata) for chunk in second],
        )

    def test_updated_analysis_replaces_previous_chunks(self):
        old_chunks = index_video_analysis(video=self.video, user=self.user)
        self.analysis.summary = "Updated persisted summary."
        self.analysis.save(update_fields=["summary", "updated_at"])

        new_chunks = index_video_analysis(video=self.video, user=self.user)

        self.assertTrue(
            any(chunk.content == "Updated persisted summary." for chunk in new_chunks)
        )
        self.assertFalse(
            KnowledgeChunk.objects.filter(
                pk__in=[chunk.pk for chunk in old_chunks]
            ).exists()
        )

    def test_indexing_one_user_does_not_replace_another_users_chunks(self):
        other_chunks = index_video_analysis(
            video=self.video,
            user=self.other_user,
        )
        original_other = [
            (chunk.pk, chunk.content, list(chunk.embedding))
            for chunk in other_chunks
        ]

        self.analysis.summary = "Changed summary for current indexing."
        self.analysis.save(update_fields=["summary", "updated_at"])
        index_video_analysis(video=self.video, user=self.user)

        self.assertEqual(
            [
                (chunk.pk, chunk.content, list(chunk.embedding))
                for chunk in KnowledgeChunk.objects.filter(
                    user=self.other_user,
                    video=self.video,
                    source_type=KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
                ).order_by("chunk_index")
            ],
            original_other,
        )

    def test_embedding_failure_preserves_old_chunks(self):
        old_chunk = index_video_analysis(video=self.video, user=self.user)[0]
        self.analysis.summary = "Replacement summary."
        self.analysis.save(update_fields=["summary", "updated_at"])
        self.embedding_service.embed_documents.side_effect = (
            EmbeddingInferenceError("simulated failure")
        )

        with self.assertRaises(VideoAnalysisIndexingError):
            index_video_analysis(video=self.video, user=self.user)

        self.assertTrue(
            KnowledgeChunk.objects.filter(pk=old_chunk.pk).exists()
        )

    def test_embedding_count_mismatch_preserves_old_chunks(self):
        old_chunk = index_video_analysis(video=self.video, user=self.user)[0]
        self.embedding_service.embed_documents.side_effect = None
        self.embedding_service.embed_documents.return_value = []

        with self.assertRaisesRegex(
            VideoAnalysisIndexingError,
            "0 vectors for",
        ):
            index_video_analysis(video=self.video, user=self.user)

        self.assertTrue(
            KnowledgeChunk.objects.filter(pk=old_chunk.pk).exists()
        )

    def test_malformed_embedding_preserves_old_chunks(self):
        old_chunk = index_video_analysis(video=self.video, user=self.user)[0]

        def malformed_embeddings(texts):
            vectors = self._fake_embeddings(texts)
            vectors[0][1] = float("nan")
            return vectors

        self.embedding_service.embed_documents.side_effect = malformed_embeddings

        with self.assertRaises(VideoAnalysisIndexingError):
            index_video_analysis(video=self.video, user=self.user)

        self.assertTrue(
            KnowledgeChunk.objects.filter(pk=old_chunk.pk).exists()
        )
