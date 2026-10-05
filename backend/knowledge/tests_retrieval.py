import math
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase

from folders.models import Folder
from knowledge.models import KnowledgeChunk
from knowledge.services.embeddings import EMBEDDING_DIMENSION
from knowledge.services.retrieval import (
    KnowledgeRetrievalError,
    RetrievalRequest,
    RetrievalScope,
    retrieve_knowledge,
    retrieve_scoped_knowledge,
)
from notes.models import Note
from videos.models import Video


def axis_vector(axis: int) -> list[float]:
    vector = [0.0] * EMBEDDING_DIMENSION
    vector[axis] = 1.0
    return vector


class KnowledgeRetrievalTests(TestCase):
    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create_user(
            username="retrieval-user",
            password="test-password",
        )
        self.other_user = user_model.objects.create_user(
            username="retrieval-other-user",
            password="test-password",
        )
        self.video_one = Video.objects.create(youtube_id="retrieval-video-1")
        self.video_two = Video.objects.create(youtube_id="retrieval-video-2")
        self.folder_one = Folder.objects.create(
            user=self.user,
            name="Retrieval folder one",
        )
        self.folder_two = Folder.objects.create(
            user=self.user,
            name="Retrieval folder two",
        )
        self.embedding_service = Mock()
        self.embedding_service.embed_query.return_value = axis_vector(0)
        patcher = patch(
            "knowledge.services.retrieval.get_embedding_service",
            return_value=self.embedding_service,
        )
        self.get_embedding_service = patcher.start()
        self.addCleanup(patcher.stop)

    def create_chunk(
        self,
        *,
        user=None,
        content="retrieval test chunk",
        embedding=None,
        video=None,
        folder=None,
        source_type=KnowledgeChunk.SourceType.NOTE,
        content_type=KnowledgeChunk.ContentType.NOTE,
    ):
        return KnowledgeChunk.objects.create(
            user=user or self.user,
            content=content,
            content_type=content_type,
            source_type=source_type,
            embedding=embedding,
            video=video,
            folder=folder,
        )

    def create_video_note(self, *, user, video, title="Video note"):
        return Note.objects.create(
            user=user,
            title=title,
            note_type=Note.NoteType.VIDEO,
            video=video,
            document={"version": 1, "blocks": []},
        )

    def test_semantic_retrieval_orders_by_cosine_distance_and_limits_results(self):
        distant = self.create_chunk(
            content="Distant",
            embedding=axis_vector(1),
        )
        medium_vector = [0.0] * EMBEDDING_DIMENSION
        medium_vector[0] = math.sqrt(0.5)
        medium_vector[1] = math.sqrt(0.5)
        medium = self.create_chunk(
            content="Medium",
            embedding=medium_vector,
        )
        nearest = self.create_chunk(
            content="Nearest",
            embedding=axis_vector(0),
        )

        results = retrieve_knowledge(
            user=self.user,
            query="  trimmed query \n",
            top_k=2,
        )

        self.embedding_service.embed_query.assert_called_once_with("trimmed query")
        self.embedding_service.embed_documents.assert_not_called()
        self.assertEqual([result.chunk.pk for result in results], [nearest.pk, medium.pk])
        self.assertEqual(len(results), 2)
        self.assertLess(results[0].distance, results[1].distance)
        self.assertGreater(results[1].distance, 0)
        self.assertTrue(all(result.chunk.pk != distant.pk for result in results))

    def test_user_isolation_applies_in_database_query(self):
        own_chunk = self.create_chunk(
            content="Own",
            embedding=axis_vector(1),
        )
        self.create_chunk(
            user=self.other_user,
            content="Other user's closer match",
            embedding=axis_vector(0),
        )

        results = retrieve_knowledge(user=self.user, query="query")

        self.assertEqual([result.chunk.pk for result in results], [own_chunk.pk])
        self.assertTrue(all(result.chunk.user_id == self.user.id for result in results))

    def test_null_embeddings_are_ignored(self):
        embedded = self.create_chunk(embedding=axis_vector(0))
        self.create_chunk(content="No embedding", embedding=None)

        results = retrieve_knowledge(user=self.user, query="query")

        self.assertEqual([result.chunk.pk for result in results], [embedded.pk])

    def test_video_filter_is_exact(self):
        matching = self.create_chunk(
            embedding=axis_vector(0),
            video=self.video_one,
        )
        self.create_chunk(
            embedding=axis_vector(0),
            video=self.video_two,
        )

        results = retrieve_knowledge(
            user=self.user,
            query="query",
            video=self.video_one,
        )

        self.assertEqual([result.chunk.pk for result in results], [matching.pk])

    def test_folder_filter_is_exact(self):
        matching = self.create_chunk(
            embedding=axis_vector(0),
            folder=self.folder_one,
        )
        self.create_chunk(
            embedding=axis_vector(0),
            folder=self.folder_two,
        )

        results = retrieve_knowledge(
            user=self.user,
            query="query",
            folder=self.folder_one,
        )

        self.assertEqual([result.chunk.pk for result in results], [matching.pk])

    def test_video_and_folder_filters_are_combined(self):
        matching = self.create_chunk(
            content="Both scopes",
            embedding=axis_vector(0),
            video=self.video_one,
            folder=self.folder_one,
        )
        self.create_chunk(
            content="Only matching video",
            embedding=axis_vector(0),
            video=self.video_one,
            folder=self.folder_two,
        )
        self.create_chunk(
            content="Only matching folder",
            embedding=axis_vector(0),
            video=self.video_two,
            folder=self.folder_one,
        )

        results = retrieve_knowledge(
            user=self.user,
            query="query",
            video=self.video_one,
            folder=self.folder_one,
        )

        self.assertEqual([result.chunk.pk for result in results], [matching.pk])

    def test_more_results_than_top_k_are_limited(self):
        chunks = [
            self.create_chunk(embedding=axis_vector(0))
            for _ in range(4)
        ]

        results = retrieve_knowledge(
            user=self.user,
            query="query",
            top_k=3,
        )

        self.assertEqual(len(results), 3)
        self.assertEqual(
            [result.chunk.pk for result in results],
            [chunk.pk for chunk in chunks[:3]],
        )

    def test_no_eligible_chunks_returns_empty_list(self):
        self.create_chunk(embedding=None)

        self.assertEqual(
            retrieve_knowledge(user=self.user, query="query"),
            [],
        )

    def test_invalid_queries_raise_before_embedding(self):
        for query in ("", " \n\t", None, 42):
            with self.subTest(query=query):
                with self.assertRaises(KnowledgeRetrievalError):
                    retrieve_knowledge(user=self.user, query=query)
        self.embedding_service.embed_query.assert_not_called()

    def test_invalid_top_k_values_raise_before_embedding(self):
        for top_k in (0, -1, 1.5, "2", True):
            with self.subTest(top_k=top_k):
                with self.assertRaises(KnowledgeRetrievalError):
                    retrieve_knowledge(
                        user=self.user,
                        query="query",
                        top_k=top_k,
                    )
        self.embedding_service.embed_query.assert_not_called()

    def test_invalid_query_embedding_is_rejected_before_database_query(self):
        self.embedding_service.embed_query.return_value = [0.0, 1.0]

        with self.assertRaisesRegex(KnowledgeRetrievalError, "dimension"):
            retrieve_knowledge(user=self.user, query="query")

    def test_non_numeric_or_non_finite_query_embedding_is_rejected(self):
        for invalid_value in ("not numeric", float("nan"), float("inf"), True):
            vector = axis_vector(0)
            vector[3] = invalid_value
            with self.subTest(value=invalid_value):
                self.embedding_service.embed_query.return_value = vector
                with self.assertRaises(KnowledgeRetrievalError):
                    retrieve_knowledge(user=self.user, query="query")

    def test_equal_distances_use_id_as_secondary_order(self):
        first = self.create_chunk(embedding=axis_vector(1))
        second = self.create_chunk(embedding=axis_vector(2))

        results = retrieve_knowledge(user=self.user, query="query")

        self.assertEqual([result.chunk.pk for result in results], [first.pk, second.pk])
        self.assertEqual(results[0].distance, results[1].distance)

    def test_embedding_service_is_called_once_with_stripped_query(self):
        self.create_chunk(embedding=axis_vector(0))

        retrieve_knowledge(user=self.user, query="  how are you?  ")

        self.embedding_service.embed_query.assert_called_once_with("how are you?")
        self.embedding_service.embed_documents.assert_not_called()

    def test_embedding_failure_is_wrapped_and_preserves_cause(self):
        failure = RuntimeError("embedding unavailable")
        self.embedding_service.embed_query.side_effect = failure

        with self.assertRaises(KnowledgeRetrievalError) as error:
            retrieve_knowledge(user=self.user, query="query")

        self.assertIs(error.exception.__cause__, failure)

    def test_current_video_scope_returns_only_selected_video_chunks(self):
        matching = self.create_chunk(
            embedding=axis_vector(0),
            video=self.video_one,
        )
        self.create_chunk(embedding=axis_vector(0), video=self.video_two)

        results = retrieve_scoped_knowledge(
            RetrievalRequest(
                user=self.user,
                query="query",
                scope=RetrievalScope.CURRENT_VIDEO,
                video=self.video_one,
            )
        )

        self.assertEqual([result.chunk.pk for result in results], [matching.pk])

    def test_current_video_includes_note_transcript_and_analysis_sources(self):
        chunks = [
            self.create_chunk(
                content="A note",
                embedding=axis_vector(0),
                video=self.video_one,
                source_type=KnowledgeChunk.SourceType.NOTE,
            ),
            self.create_chunk(
                content="A transcript",
                embedding=axis_vector(0),
                video=self.video_one,
                source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
                content_type=KnowledgeChunk.ContentType.TRANSCRIPT_CHUNK,
            ),
            self.create_chunk(
                content="An analysis",
                embedding=axis_vector(0),
                video=self.video_one,
                source_type=KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
                content_type=KnowledgeChunk.ContentType.ANALYSIS_CHUNK,
            ),
        ]
        self.create_chunk(
            user=self.other_user,
            content="Another user's transcript",
            embedding=axis_vector(0),
            video=self.video_one,
            source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
            content_type=KnowledgeChunk.ContentType.TRANSCRIPT_CHUNK,
        )

        results = retrieve_scoped_knowledge(
            RetrievalRequest(
                user=self.user,
                query="query",
                scope=RetrievalScope.CURRENT_VIDEO,
                video=self.video_one,
            )
        )

        self.assertCountEqual(
            [result.chunk.pk for result in results],
            [chunk.pk for chunk in chunks],
        )
        self.assertTrue(
            all(result.chunk.user_id == self.user.pk for result in results)
        )

    def test_current_video_scope_requires_video(self):
        with self.assertRaisesRegex(KnowledgeRetrievalError, "requires a video"):
            retrieve_scoped_knowledge(
                RetrievalRequest(
                    user=self.user,
                    query="query",
                    scope=RetrievalScope.CURRENT_VIDEO,
                )
            )

        self.embedding_service.embed_query.assert_not_called()

    def test_current_folder_scope_returns_only_selected_folder_chunks(self):
        matching = self.create_chunk(
            embedding=axis_vector(0),
            folder=self.folder_one,
        )
        self.create_chunk(embedding=axis_vector(0), folder=self.folder_two)

        results = retrieve_scoped_knowledge(
            RetrievalRequest(
                user=self.user,
                query="query",
                scope=RetrievalScope.CURRENT_FOLDER,
                folder=self.folder_one,
            )
        )

        self.assertEqual([result.chunk.pk for result in results], [matching.pk])

    def test_current_folder_scope_requires_folder(self):
        with self.assertRaisesRegex(
            KnowledgeRetrievalError,
            "requires a folder",
        ):
            retrieve_scoped_knowledge(
                RetrievalRequest(
                    user=self.user,
                    query="query",
                    scope=RetrievalScope.CURRENT_FOLDER,
                )
            )

        self.embedding_service.embed_query.assert_not_called()

    def test_personal_kb_scope_includes_chunks_across_contexts(self):
        chunks = [
            self.create_chunk(
                embedding=axis_vector(0),
                video=self.video_one,
                folder=self.folder_one,
            ),
            self.create_chunk(
                embedding=axis_vector(0),
                video=self.video_two,
                folder=self.folder_two,
            ),
            self.create_chunk(embedding=axis_vector(0)),
        ]

        results = retrieve_scoped_knowledge(
            RetrievalRequest(
                user=self.user,
                query="query",
                scope=RetrievalScope.PERSONAL_KB,
            )
        )

        self.assertCountEqual(
            [result.chunk.pk for result in results],
            [chunk.pk for chunk in chunks],
        )

    def test_personal_kb_includes_each_video_knowledge_source_type(self):
        chunks = [
            self.create_chunk(
                embedding=axis_vector(0),
                video=self.video_one,
                source_type=KnowledgeChunk.SourceType.NOTE,
            ),
            self.create_chunk(
                embedding=axis_vector(0),
                video=self.video_one,
                source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
                content_type=KnowledgeChunk.ContentType.TRANSCRIPT_CHUNK,
            ),
            self.create_chunk(
                embedding=axis_vector(0),
                video=self.video_one,
                source_type=KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
                content_type=KnowledgeChunk.ContentType.ANALYSIS_CHUNK,
            ),
        ]
        self.create_chunk(
            user=self.other_user,
            embedding=axis_vector(0),
            video=self.video_one,
            source_type=KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
            content_type=KnowledgeChunk.ContentType.ANALYSIS_CHUNK,
        )

        results = retrieve_scoped_knowledge(
            RetrievalRequest(
                user=self.user,
                query="query",
                scope=RetrievalScope.PERSONAL_KB,
            )
        )

        self.assertCountEqual(
            [result.chunk.pk for result in results],
            [chunk.pk for chunk in chunks],
        )

    def test_personal_kb_ignores_optional_video_and_folder_context(self):
        included_from_other_context = self.create_chunk(
            embedding=axis_vector(0),
            video=self.video_two,
            folder=self.folder_two,
        )
        included_from_selected_context = self.create_chunk(
            embedding=axis_vector(0),
            video=self.video_one,
            folder=self.folder_one,
        )

        results = retrieve_scoped_knowledge(
            RetrievalRequest(
                user=self.user,
                query="query",
                scope=RetrievalScope.PERSONAL_KB,
                video=self.video_one,
                folder=self.folder_one,
            )
        )

        self.assertEqual(
            {result.chunk.pk for result in results},
            {
                included_from_other_context.pk,
                included_from_selected_context.pk,
            },
        )

    def test_combined_scope_matches_personal_kb_without_duplicates(self):
        chunks = [
            self.create_chunk(
                embedding=axis_vector(0),
                video=self.video_one,
                folder=self.folder_one,
            ),
            self.create_chunk(
                embedding=axis_vector(0),
                video=self.video_two,
                folder=self.folder_two,
            ),
            self.create_chunk(embedding=axis_vector(0)),
        ]
        personal_request = RetrievalRequest(
            user=self.user,
            query="query",
            scope=RetrievalScope.PERSONAL_KB,
        )
        combined_request = RetrievalRequest(
            user=self.user,
            query="query",
            scope=RetrievalScope.COMBINED,
            video=self.video_one,
            folder=self.folder_one,
        )

        personal_results = retrieve_scoped_knowledge(personal_request)
        combined_results = retrieve_scoped_knowledge(combined_request)

        combined_ids = [result.chunk.pk for result in combined_results]
        self.assertCountEqual(
            combined_ids,
            [result.chunk.pk for result in personal_results],
        )
        self.assertEqual(len(combined_ids), len(set(combined_ids)))
        self.assertCountEqual(combined_ids, [chunk.pk for chunk in chunks])

    def test_combined_prioritizes_relevant_current_video_over_personal_matches(self):
        def vector_with_similarity(similarity):
            vector = [0.0] * EMBEDDING_DIMENSION
            vector[0] = similarity
            vector[1] = math.sqrt(1 - similarity**2)
            return vector

        current_video_chunks = [
            self.create_chunk(
                content=f"Current video {similarity}",
                embedding=vector_with_similarity(similarity),
                video=self.video_one,
                source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
                content_type=KnowledgeChunk.ContentType.TRANSCRIPT_CHUNK,
            )
            for similarity in (0.8, 0.7)
        ]
        personal_chunks = [
            self.create_chunk(
                content=f"Personal match {index}",
                embedding=axis_vector(0),
            )
            for index in range(5)
        ]

        results = retrieve_scoped_knowledge(
            RetrievalRequest(
                user=self.user,
                query="video question",
                scope=RetrievalScope.COMBINED,
                video=self.video_one,
                top_k=5,
            )
        )

        result_ids = [result.chunk.pk for result in results]
        self.assertEqual(
            result_ids[:2],
            [chunk.pk for chunk in current_video_chunks],
        )
        self.assertEqual(
            result_ids[2:],
            [chunk.pk for chunk in personal_chunks[:3]],
        )

    def test_combined_current_video_pool_includes_all_supported_sources(self):
        video_chunks = [
            self.create_chunk(
                content="Video note",
                embedding=axis_vector(0),
                video=self.video_one,
                source_type=KnowledgeChunk.SourceType.NOTE,
            ),
            self.create_chunk(
                content="Video transcript",
                embedding=axis_vector(0),
                video=self.video_one,
                source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
                content_type=KnowledgeChunk.ContentType.TRANSCRIPT_CHUNK,
            ),
            self.create_chunk(
                content="Video analysis",
                embedding=axis_vector(0),
                video=self.video_one,
                source_type=KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
                content_type=KnowledgeChunk.ContentType.ANALYSIS_CHUNK,
            ),
        ]

        results = retrieve_scoped_knowledge(
            RetrievalRequest(
                user=self.user,
                query="video question",
                scope=RetrievalScope.COMBINED,
                video=self.video_one,
                top_k=3,
            )
        )

        self.assertCountEqual(
            [result.chunk.pk for result in results],
            [chunk.pk for chunk in video_chunks],
        )
        self.assertCountEqual(
            [result.chunk.source_type for result in results],
            [
                KnowledgeChunk.SourceType.NOTE,
                KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
                KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
            ],
        )

    def test_combined_fills_video_results_with_relevant_personal_knowledge(self):
        video_chunk = self.create_chunk(
            content="Current video result",
            embedding=axis_vector(0),
            video=self.video_one,
            source_type=KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
            content_type=KnowledgeChunk.ContentType.ANALYSIS_CHUNK,
        )
        personal_chunks = [
            self.create_chunk(
                content=f"Personal result {index}",
                embedding=axis_vector(0),
            )
            for index in range(4)
        ]

        results = retrieve_scoped_knowledge(
            RetrievalRequest(
                user=self.user,
                query="video question",
                scope=RetrievalScope.COMBINED,
                video=self.video_one,
                top_k=4,
            )
        )

        self.assertEqual(
            [result.chunk.pk for result in results],
            [video_chunk.pk, *(chunk.pk for chunk in personal_chunks[:3])],
        )

    def test_combined_deduplicates_chunks_in_video_and_personal_pools(self):
        shared_chunk = self.create_chunk(
            content="Current video note",
            embedding=axis_vector(0),
            video=self.video_one,
        )
        personal_chunk = self.create_chunk(
            content="Personal note",
            embedding=axis_vector(0),
        )

        results = retrieve_scoped_knowledge(
            RetrievalRequest(
                user=self.user,
                query="video question",
                scope=RetrievalScope.COMBINED,
                video=self.video_one,
                top_k=3,
            )
        )

        result_ids = [result.chunk.pk for result in results]
        self.assertEqual(result_ids, [shared_chunk.pk, personal_chunk.pk])
        self.assertEqual(len(result_ids), len(set(result_ids)))

    def test_combined_without_video_results_returns_personal_knowledge(self):
        personal_chunks = [
            self.create_chunk(
                content=f"Personal result {index}",
                embedding=axis_vector(0),
                video=self.video_two,
            )
            for index in range(3)
        ]

        results = retrieve_scoped_knowledge(
            RetrievalRequest(
                user=self.user,
                query="video question",
                scope=RetrievalScope.COMBINED,
                video=self.video_one,
                top_k=3,
            )
        )

        self.assertEqual(
            [result.chunk.pk for result in results],
            [chunk.pk for chunk in personal_chunks],
        )

    def test_combined_context_combinations_deduplicate_and_isolate_users(self):
        video_note = self.create_chunk(
            embedding=axis_vector(0),
            video=self.video_one,
            folder=self.folder_one,
        )
        video_transcript = self.create_chunk(
            embedding=axis_vector(0),
            video=self.video_one,
            source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
            content_type=KnowledgeChunk.ContentType.TRANSCRIPT_CHUNK,
        )
        folder_note = self.create_chunk(
            embedding=axis_vector(0),
            folder=self.folder_one,
        )
        personal_note = self.create_chunk(embedding=axis_vector(0))
        self.create_chunk(
            user=self.other_user,
            embedding=axis_vector(0),
            video=self.video_one,
        )
        cases = (
            (self.video_one, self.folder_one),
            (self.video_one, None),
            (None, self.folder_one),
            (None, None),
        )
        expected_ids = {
            video_note.pk,
            video_transcript.pk,
            folder_note.pk,
            personal_note.pk,
        }

        for video, folder in cases:
            with self.subTest(video=video, folder=folder):
                results = retrieve_scoped_knowledge(
                    RetrievalRequest(
                        user=self.user,
                        query="query",
                        scope=RetrievalScope.COMBINED,
                        video=video,
                        folder=folder,
                    )
                )
                result_ids = [result.chunk.pk for result in results]
                self.assertEqual(len(result_ids), len(set(result_ids)))
                self.assertEqual(set(result_ids), expected_ids)
                self.assertTrue(
                    all(result.chunk.user_id == self.user.pk for result in results)
                )

    def test_current_folder_does_not_include_unassigned_video_knowledge(self):
        folder_chunk = self.create_chunk(
            embedding=axis_vector(0),
            folder=self.folder_one,
        )
        self.create_chunk(
            embedding=axis_vector(0),
            video=self.video_one,
            folder=None,
            source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
            content_type=KnowledgeChunk.ContentType.TRANSCRIPT_CHUNK,
        )
        self.create_chunk(
            embedding=axis_vector(0),
            video=self.video_one,
            folder=None,
            source_type=KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
            content_type=KnowledgeChunk.ContentType.ANALYSIS_CHUNK,
        )

        results = retrieve_scoped_knowledge(
            RetrievalRequest(
                user=self.user,
                query="query",
                scope=RetrievalScope.CURRENT_FOLDER,
                folder=self.folder_one,
            )
        )

        self.assertEqual([result.chunk.pk for result in results], [folder_chunk.pk])

    def test_video_associated_only_with_another_user_is_rejected(self):
        self.create_video_note(user=self.other_user, video=self.video_two)
        self.create_chunk(
            user=self.other_user,
            embedding=axis_vector(0),
            video=self.video_two,
        )

        with self.assertRaisesRegex(KnowledgeRetrievalError, "another user's"):
            retrieve_scoped_knowledge(
                RetrievalRequest(
                    user=self.user,
                    query="query",
                    scope=RetrievalScope.CURRENT_VIDEO,
                    video=self.video_two,
                )
            )

        self.embedding_service.embed_query.assert_not_called()

    def test_folder_owned_by_another_user_is_rejected(self):
        other_folder = Folder.objects.create(
            user=self.other_user,
            name="Other user's folder",
        )

        with self.assertRaisesRegex(KnowledgeRetrievalError, "does not belong"):
            retrieve_scoped_knowledge(
                RetrievalRequest(
                    user=self.user,
                    query="query",
                    scope=RetrievalScope.CURRENT_FOLDER,
                    folder=other_folder,
                )
            )

        self.embedding_service.embed_query.assert_not_called()
