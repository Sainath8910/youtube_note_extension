from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase, TestCase

from folders.models import Folder
from knowledge.models import KnowledgeChunk
from knowledge.services.embeddings import EMBEDDING_DIMENSION
from knowledge.services.context import RAGContext, RAGContextItem
from knowledge.services.generation import (
    RAGAnswer,
    RAGGenerationError,
)
from knowledge.services.rag import answer_question
from knowledge.services.retrieval import RetrievalRequest, RetrievalScope
from notes.models import Note
from videos.models import Video


class RAGOrchestrationTests(SimpleTestCase):
    def setUp(self):
        self.user = SimpleNamespace(pk=51)
        self.request = RetrievalRequest(
            user=self.user,
            query="original request query",
            scope=RetrievalScope.PERSONAL_KB,
            top_k=2,
        )
        self.context = RAGContext(
            question="What does my note say?",
            scope=RetrievalScope.PERSONAL_KB,
            items=(
                RAGContextItem(
                    chunk_id=88,
                    content="A sourced fact.",
                    distance=0.15,
                    note_id=12,
                    video_id=None,
                    folder_id=None,
                    source_block_id="block-88",
                    chunk_index=0,
                    metadata={},
                ),
            ),
        )
        self.answer = RAGAnswer(
            answer="Your note contains a sourced fact.",
            sources=self.context.items,
        )

    @patch("knowledge.services.rag.generate_rag_answer")
    @patch("knowledge.services.rag.assemble_rag_context")
    def test_delegates_once_and_returns_exact_generation_result(
        self,
        assemble,
        generate,
    ):
        provider = Mock()
        assemble.return_value = self.context
        generate.return_value = self.answer

        result = answer_question(
            user=self.user,
            question="  What does my note say?  ",
            request=self.request,
            top_k=7,
            provider=provider,
        )

        self.assertIs(result, self.answer)
        assemble.assert_called_once_with(
            user=self.user,
            question="  What does my note say?  ",
            request=self.request,
            top_k=7,
        )
        generate.assert_called_once_with(
            context=self.context,
            provider=provider,
        )

    @patch("knowledge.services.rag.generate_rag_answer")
    @patch("knowledge.services.rag.assemble_rag_context")
    def test_forwards_default_provider_as_none(
        self,
        assemble,
        generate,
    ):
        assemble.return_value = self.context
        generate.return_value = self.answer

        answer_question(
            user=self.user,
            question="Question",
            request=self.request,
            provider=None,
        )

        generate.assert_called_once_with(
            context=self.context,
            provider=None,
        )

    @patch("knowledge.services.rag.generate_rag_answer")
    @patch("knowledge.services.rag.assemble_rag_context")
    def test_context_assembly_error_propagates_and_skips_generation(
        self,
        assemble,
        generate,
    ):
        error = ValueError("invalid retrieval request")
        assemble.side_effect = error

        with self.assertRaises(ValueError) as raised:
            answer_question(
                user=self.user,
                question="Question",
                request=self.request,
            )

        self.assertIs(raised.exception, error)
        assemble.assert_called_once()
        generate.assert_not_called()

    @patch("knowledge.services.rag.generate_rag_answer")
    @patch("knowledge.services.rag.assemble_rag_context")
    def test_generation_error_propagates_unchanged(
        self,
        assemble,
        generate,
    ):
        assemble.return_value = self.context
        error = RAGGenerationError("generation unavailable")
        generate.side_effect = error

        with self.assertRaises(RAGGenerationError) as raised:
            answer_question(
                user=self.user,
                question="Question",
                request=self.request,
            )

        self.assertIs(raised.exception, error)
        assemble.assert_called_once()
        generate.assert_called_once_with(
            context=self.context,
            provider=None,
        )

    def test_module_does_not_import_or_expose_lower_level_retrieval(self):
        import knowledge.services.rag as rag_module

        self.assertFalse(hasattr(rag_module, "retrieve_knowledge"))
        self.assertFalse(hasattr(rag_module, "retrieve_scoped_knowledge"))


class VideoKnowledgeRAGIntegrationTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username="video-rag-user",
        )
        self.video = Video.objects.create(youtube_id="video-rag-test")
        self.folder = Folder.objects.create(user=self.user, name="Video RAG")
        self.query_vector = [0.0] * EMBEDDING_DIMENSION
        self.query_vector[0] = 1.0
        embedding_service = Mock()
        embedding_service.embed_query.return_value = self.query_vector
        patcher = patch(
            "knowledge.services.retrieval.get_embedding_service",
            return_value=embedding_service,
        )
        self.get_embedding_service = patcher.start()
        self.addCleanup(patcher.stop)
        self.provider = Mock()
        self.provider.generate.return_value = "Grounded video answer."

    def add_chunk(
        self,
        *,
        content,
        source_type,
        content_type,
        note=None,
        video=None,
        folder=None,
        metadata=None,
    ):
        return KnowledgeChunk.objects.create(
            user=self.user,
            note=note,
            video=video,
            folder=folder,
            content=content,
            content_type=content_type,
            source_type=source_type,
            metadata=metadata or {},
            embedding=self.query_vector,
        )

    def add_video_sources(self):
        note = Note.objects.create(
            user=self.user,
            title="My video note",
            note_type=Note.NoteType.VIDEO,
            video=self.video,
            folder=self.folder,
        )
        note_chunk = self.add_chunk(
            content="My note: binary search halves the remaining candidates.",
            source_type=KnowledgeChunk.SourceType.NOTE,
            content_type=KnowledgeChunk.ContentType.NOTE_BLOCK,
            note=note,
            video=self.video,
            folder=self.folder,
            metadata={"block_type": "paragraph"},
        )
        transcript_chunk = self.add_chunk(
            content="Transcript: binary search requires sorted data.",
            source_type=KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
            content_type=KnowledgeChunk.ContentType.TRANSCRIPT_CHUNK,
            video=self.video,
            metadata={
                "source_type": KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
                "start_seconds": 1.0,
                "end_seconds": 4.0,
            },
        )
        analysis_chunk = self.add_chunk(
            content="Analysis: binary search runs in logarithmic time.",
            source_type=KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
            content_type=KnowledgeChunk.ContentType.ANALYSIS_CHUNK,
            video=self.video,
            metadata={
                "source_type": KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
                "section": "concepts",
                "subsection": "Binary search",
            },
        )
        return note_chunk, transcript_chunk, analysis_chunk

    def test_current_video_context_reaches_generation_with_all_sources(self):
        expected = self.add_video_sources()
        request = RetrievalRequest(
            user=self.user,
            query="What do I know about binary search?",
            scope=RetrievalScope.CURRENT_VIDEO,
            video=self.video,
        )

        answer = answer_question(
            user=self.user,
            question=request.query,
            request=request,
            top_k=3,
            provider=self.provider,
        )

        self.assertEqual(answer.answer, "Grounded video answer.")
        self.assertEqual(
            {source.chunk_id for source in answer.sources},
            {chunk.pk for chunk in expected},
        )
        self.assertEqual(
            {
                source.metadata["source_type"]
                for source in answer.sources
            },
            {
                KnowledgeChunk.SourceType.NOTE,
                KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
                KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
            },
        )
        prompt = self.provider.generate.call_args.kwargs["prompt"]
        self.assertIn("Transcript: binary search requires sorted data.", prompt)
        self.assertIn("Analysis: binary search runs in logarithmic time.", prompt)
        self.assertIn("My note: binary search halves the remaining candidates.", prompt)

    def test_combined_context_generates_from_video_and_personal_knowledge(self):
        note_chunk, transcript_chunk, analysis_chunk = self.add_video_sources()
        personal_note = Note.objects.create(
            user=self.user,
            title="Personal binary search note",
            note_type=Note.NoteType.STANDALONE,
            document={"version": 1, "blocks": []},
        )
        personal_chunk = self.add_chunk(
            content="Personal note: binary search can be iterative or recursive.",
            source_type=KnowledgeChunk.SourceType.NOTE,
            content_type=KnowledgeChunk.ContentType.NOTE_BLOCK,
            note=personal_note,
        )
        request = RetrievalRequest(
            user=self.user,
            query="What do I know about binary search?",
            scope=RetrievalScope.COMBINED,
            video=self.video,
            folder=self.folder,
        )

        answer = answer_question(
            user=self.user,
            question=request.query,
            request=request,
            top_k=4,
            provider=self.provider,
        )

        expected_ids = {
            note_chunk.pk,
            transcript_chunk.pk,
            analysis_chunk.pk,
            personal_chunk.pk,
        }
        self.assertEqual(
            {source.chunk_id for source in answer.sources},
            expected_ids,
        )
        self.assertEqual(
            len({source.chunk_id for source in answer.sources}),
            len(answer.sources),
        )
        self.assertEqual(
            {
                source.metadata["source_type"]
                for source in answer.sources
            },
            {
                KnowledgeChunk.SourceType.NOTE,
                KnowledgeChunk.SourceType.VIDEO_TRANSCRIPT,
                KnowledgeChunk.SourceType.VIDEO_ANALYSIS,
            },
        )
        prompt = self.provider.generate.call_args.kwargs["prompt"]
        self.assertIn(
            "Personal note: binary search can be iterative or recursive.",
            prompt,
        )
