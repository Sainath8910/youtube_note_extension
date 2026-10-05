from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from knowledge.models import KnowledgeChunk
from knowledge.services.analysis_indexing import index_video_analysis
from knowledge.services.context import assemble_rag_context
from knowledge.services.embeddings import EMBEDDING_DIMENSION
from knowledge.services.rag import answer_question
from knowledge.services.retrieval import (
    KnowledgeRetrievalError,
    RetrievalRequest,
    RetrievalScope,
    retrieve_scoped_knowledge,
)
from knowledge.services.transcript_indexing import index_video_transcript
from notes.models import Note
from videos.models import Video, VideoAnalysis
from videos.services.analysis_providers import (
    AnalysisProviderManager,
    AnalysisResult,
)
from videos.services.youtube import YouTubeMetadataError


class VideoKnowledgePipelineTests(TestCase):
    question = "What do I know about binary search?"
    transcript_text = (
        "The video explains binary search. It requires sorted data and "
        "repeatedly halves the search interval."
    )
    analysis_summary = (
        "Binary search has logarithmic search complexity when the search "
        "interval is halved."
    )
    note_text = (
        "My note: binary search compares the target with the middle element "
        "and eliminates half of the remaining search space."
    )

    def setUp(self):
        user_model = get_user_model()
        self.user = user_model.objects.create_user(
            username="video-pipeline-user",
        )
        self.other_user = user_model.objects.create_user(
            username="video-pipeline-other-user",
        )
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.embedding_vector = [0.0] * EMBEDDING_DIMENSION
        self.embedding_vector[0] = 1.0
        self.embedding_service = Mock()
        self.embedding_service.embed_documents.side_effect = (
            self._document_embeddings
        )
        self.embedding_service.embed_query.return_value = self.embedding_vector
        self.transcript = {
            "language": "en",
            "segments": [
                {
                    "text": self.transcript_text,
                    "start": 0.0,
                    "duration": 12.0,
                }
            ],
        }
        self.analysis_result = AnalysisResult(
            summary=self.analysis_summary,
            detailed_notes={
                "sections": [
                    {
                        "heading": "Search complexity",
                        "content": (
                            "Halving the interval gives logarithmic search "
                            "complexity."
                        ),
                    }
                ],
                "definitions": [],
                "examples": [],
            },
            topics=["Searching"],
            concepts=["Binary search"],
            prerequisites=["Sorted data"],
            upcoming_topics=[],
            key_points=[
                {
                    "text": "Each step halves the search interval.",
                    "start": 0.0,
                }
            ],
            claims=[],
            questions=["Why must the data be sorted?"],
            model="deterministic-test-provider",
            analysis_version=1,
        )
        self.video = Video.objects.create(youtube_id="pipeline001")
        self.generation_provider = Mock()
        self.generation_provider.generate.return_value = (
            "Binary search halves a sorted search interval."
        )

    def _document_embeddings(self, texts):
        return [self.embedding_vector.copy() for _ in texts]

    def _run_transcript_lifecycle(self):
        with (
            patch(
                "videos.views.fetch_youtube_transcript",
                return_value=self.transcript,
            ) as fetch_transcript,
            patch(
                "knowledge.services.transcript_indexing.get_embedding_service",
                return_value=self.embedding_service,
            ),
        ):
            response = self.client.post(
                f"/api/videos/{self.video.youtube_id}/transcript/",
                {},
                format="json",
            )
        self.assertEqual(response.status_code, 200)
        fetch_transcript.assert_called_once_with(self.video.youtube_id)
        self.video.refresh_from_db()
        self.assertEqual(
            self.video.transcript_status,
            Video.TranscriptStatus.READY,
        )
        self.assertEqual(self.video.transcript, self.transcript["segments"])
        return response

    def _create_video_note(self):
        with (
            patch(
                "notes.views.fetch_youtube_metadata",
                side_effect=YouTubeMetadataError("test metadata unavailable"),
            ),
            patch(
                "knowledge.services.indexing.get_embedding_service",
                return_value=self.embedding_service,
            ),
        ):
            response = self.client.post(
                "/api/notes/video/",
                {
                    "youtube_id": self.video.youtube_id,
                    "title": "Binary search note",
                    "content": self.note_text,
                    "document": {
                        "version": 1,
                        "blocks": [
                            {
                                "id": "binary-search-note-block",
                                "type": "paragraph",
                                "content": self.note_text,
                            }
                        ],
                    },
                    "note_type": Note.NoteType.VIDEO,
                    "timestamp_seconds": None,
                    "folder": None,
                },
                format="json",
            )
        self.assertEqual(response.status_code, 201)
        return Note.objects.get(pk=response.data["note"]["id"])

    def _run_analysis_lifecycle(self):
        provider = Mock()
        provider.analyze.return_value = self.analysis_result
        manager = AnalysisProviderManager([provider])
        with (
            patch(
                "videos.views.build_analysis_provider_manager",
                return_value=manager,
            ),
            patch(
                "knowledge.services.analysis_indexing.get_embedding_service",
                return_value=self.embedding_service,
            ),
        ):
            response = self.client.post(
                f"/api/videos/{self.video.youtube_id}/analyze/",
                {},
                format="json",
            )
        self.assertEqual(response.status_code, 200)
        provider.analyze.assert_called_once()
        self.video.refresh_from_db()
        self.assertEqual(
            self.video.analysis_status,
            Video.AnalysisStatus.READY,
        )
        self.assertTrue(VideoAnalysis.objects.filter(video=self.video).exists())
        return response

    def _retrieval_request(self):
        return RetrievalRequest(
            user=self.user,
            query=self.question,
            scope=RetrievalScope.CURRENT_VIDEO,
            video=self.video,
            top_k=20,
        )

    def test_video_lifecycle_populates_and_answers_current_video_knowledge(self):
        self._run_transcript_lifecycle()
        note = self._create_video_note()
        self._run_analysis_lifecycle()

        transcript_chunks = list(
            KnowledgeChunk.objects.filter(
                user=self.user,
                video=self.video,
                source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
                content_type=KnowledgeChunk.ContentType.TRANSCRIPT_CHUNK,
            )
        )
        note_chunks = list(
            KnowledgeChunk.objects.filter(
                user=self.user,
                video=self.video,
                note=note,
                source_type=KnowledgeChunk.SourceType.NOTE,
            )
        )
        analysis_chunks = list(
            KnowledgeChunk.objects.filter(
                user=self.user,
                video=self.video,
                source_type=KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
                content_type=KnowledgeChunk.ContentType.ANALYSIS_CHUNK,
            )
        )
        self.assertTrue(transcript_chunks)
        self.assertEqual(len(note_chunks), 1)
        self.assertTrue(analysis_chunks)
        self.assertTrue(
            all(
                chunk.user == self.user
                and chunk.video == self.video
                and chunk.embedding is not None
                for chunk in (
                    transcript_chunks + note_chunks + analysis_chunks
                )
            )
        )
        self.assertIn(
            self.transcript_text,
            transcript_chunks[0].content,
        )
        self.assertIn(self.note_text, note_chunks[0].content)
        self.assertTrue(
            any(
                self.analysis_summary in chunk.content
                for chunk in analysis_chunks
            )
        )

        original_count = KnowledgeChunk.objects.filter(
            user=self.user,
            video=self.video,
        ).count()
        with (
            patch(
                "knowledge.services.transcript_indexing.get_embedding_service",
                return_value=self.embedding_service,
            ),
            patch(
                "knowledge.services.analysis_indexing.get_embedding_service",
                return_value=self.embedding_service,
            ),
        ):
            index_video_transcript(video=self.video, user=self.user)
            index_video_analysis(video=self.video, user=self.user)
        self.assertEqual(
            KnowledgeChunk.objects.filter(
                user=self.user,
                video=self.video,
            ).count(),
            original_count,
        )
        self.assertEqual(
            KnowledgeChunk.objects.filter(
                user=self.user,
                video=self.video,
                note=note,
                source_type=KnowledgeChunk.SourceType.NOTE,
            ).count(),
            1,
        )

        self.embedding_service.embed_query.return_value = self.embedding_vector
        with patch(
            "knowledge.services.retrieval.get_embedding_service",
            return_value=self.embedding_service,
        ):
            results = retrieve_scoped_knowledge(self._retrieval_request())
            self.assertLessEqual(len(results), 20)
            result_ids = [result.chunk.pk for result in results]
            self.assertEqual(len(result_ids), len(set(result_ids)))
            self.assertEqual(
                result_ids,
                sorted(
                    result_ids,
                    key=lambda chunk_id: next(
                        (result.distance, result.chunk.pk)
                        for result in results
                        if result.chunk.pk == chunk_id
                    ),
                ),
            )
            self.assertTrue(
                all(
                    result.chunk.user_id == self.user.pk
                    and result.chunk.video_id == self.video.pk
                    for result in results
                )
            )
            result_types = {result.chunk.source_type for result in results}
            self.assertEqual(
                result_types,
                {
                    KnowledgeChunk.SourceType.NOTE,
                    KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
                    KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
                },
            )

            context = assemble_rag_context(
                user=self.user,
                question=self.question,
                request=self._retrieval_request(),
                top_k=20,
            )
            self.assertEqual(context.question, self.question)
            self.assertEqual(
                [item.chunk_id for item in context.items],
                result_ids,
            )
            self.assertEqual(
                len({item.chunk_id for item in context.items}),
                len(context.items),
            )
            self.assertEqual(
                {item.metadata["source_type"] for item in context.items},
                result_types,
            )
            self.assertTrue(
                all(item.video_id == self.video.pk for item in context.items)
            )
            note_context = next(
                item for item in context.items if item.note_id == note.pk
            )
            self.assertIsNone(note_context.folder_id)
            self.assertIsNotNone(note_context.note_id)

            answer = answer_question(
                user=self.user,
                question=self.question,
                request=self._retrieval_request(),
                top_k=20,
                provider=self.generation_provider,
            )

        self.assertEqual(
            answer.answer,
            "Binary search halves a sorted search interval.",
        )
        self.assertEqual(
            [source.chunk_id for source in answer.sources],
            [item.chunk_id for item in context.items],
        )
        self.assertEqual(
            [source.metadata["source_type"] for source in answer.sources],
            [item.metadata["source_type"] for item in context.items],
        )
        self.generation_provider.generate.assert_called_once()
        generation_call = self.generation_provider.generate.call_args.kwargs
        self.assertEqual(generation_call["question"], self.question)
        for source_text in (
            self.transcript_text,
            self.analysis_summary,
            self.note_text,
        ):
            self.assertIn(source_text, generation_call["prompt"])

        self.client.force_authenticate(self.other_user)
        with patch(
            "knowledge.services.retrieval.get_embedding_service",
            return_value=self.embedding_service,
        ):
            with self.assertRaisesRegex(
                KnowledgeRetrievalError,
                "another user's",
            ):
                retrieve_scoped_knowledge(
                    RetrievalRequest(
                        user=self.other_user,
                        query=self.question,
                        scope=RetrievalScope.CURRENT_VIDEO,
                        video=self.video,
                        top_k=20,
                    )
                )
            with self.assertRaises(KnowledgeRetrievalError):
                assemble_rag_context(
                    user=self.other_user,
                    question=self.question,
                    request=RetrievalRequest(
                        user=self.other_user,
                        query=self.question,
                        scope=RetrievalScope.CURRENT_VIDEO,
                        video=self.video,
                        top_k=20,
                    ),
                    top_k=20,
                )
