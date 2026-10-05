from dataclasses import FrozenInstanceError
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from knowledge.services.context import (
    RAGContext,
    RAGContextItem,
    assemble_rag_context,
)
from knowledge.services.retrieval import (
    KnowledgeRetrievalError,
    RetrievalRequest,
    RetrievalScope,
    RetrievalResult,
)


class RAGContextAssemblyTests(SimpleTestCase):
    def setUp(self):
        self.user = SimpleNamespace(pk=17)
        self.request = RetrievalRequest(
            user=self.user,
            query="request's original query",
            scope=RetrievalScope.CURRENT_VIDEO,
            top_k=2,
        )

    @staticmethod
    def make_result(
        chunk_id,
        content,
        distance,
        *,
        note_id=None,
        video_id=None,
        folder_id=None,
        source_block_id=None,
        chunk_index=0,
        metadata=None,
    ):
        chunk = SimpleNamespace(
            pk=chunk_id,
            content=content,
            note_id=note_id,
            video_id=video_id,
            folder_id=folder_id,
            source_block_id=source_block_id,
            chunk_index=chunk_index,
            metadata={} if metadata is None else metadata,
        )
        return RetrievalResult(chunk=chunk, distance=distance)

    @patch("knowledge.services.context.retrieve_scoped_knowledge")
    def test_assembles_source_fields_and_preserves_retrieval_order(self, retrieve):
        first = self.make_result(
            12,
            "First chunk",
            0.12,
            note_id=3,
            video_id=4,
            folder_id=5,
            source_block_id="block-a",
            chunk_index=6,
            metadata={"source": "note"},
        )
        second = self.make_result(
            11,
            "Second chunk",
            0.24,
            note_id=None,
            video_id=None,
            folder_id=7,
            source_block_id=None,
            chunk_index=1,
            metadata={"kind": "standalone"},
        )
        retrieve.return_value = [first, second]

        context = assemble_rag_context(
            user=self.user,
            question="  What is binary search?  ",
            request=self.request,
            top_k=9,
        )

        self.assertIsInstance(context, RAGContext)
        self.assertEqual(context.question, "What is binary search?")
        self.assertEqual(context.scope, RetrievalScope.CURRENT_VIDEO)
        self.assertEqual(
            context.items,
            (
                RAGContextItem(
                    chunk_id=12,
                    content="First chunk",
                    distance=0.12,
                    note_id=3,
                    video_id=4,
                    folder_id=5,
                    source_block_id="block-a",
                    chunk_index=6,
                    metadata={"source": "note"},
                ),
                RAGContextItem(
                    chunk_id=11,
                    content="Second chunk",
                    distance=0.24,
                    note_id=None,
                    video_id=None,
                    folder_id=7,
                    source_block_id=None,
                    chunk_index=1,
                    metadata={"kind": "standalone"},
                ),
            ),
        )
        retrieve.assert_called_once()
        actual_request = retrieve.call_args.args[0]
        self.assertEqual(actual_request.user, self.user)
        self.assertEqual(actual_request.query, "What is binary search?")
        self.assertEqual(actual_request.top_k, 9)
        self.assertEqual(actual_request.scope, self.request.scope)
        self.assertEqual(self.request.query, "request's original query")
        self.assertEqual(self.request.top_k, 2)

    @patch("knowledge.services.context.retrieve_scoped_knowledge")
    def test_empty_retrieval_returns_empty_items(self, retrieve):
        retrieve.return_value = []

        context = assemble_rag_context(
            user=self.user,
            question="Question",
            request=self.request,
        )

        self.assertEqual(context.items, ())

    @patch("knowledge.services.context.retrieve_scoped_knowledge")
    def test_duplicate_chunk_ids_keep_the_first_result(self, retrieve):
        first = self.make_result(5, "First version", 0.1)
        duplicate = self.make_result(5, "Later duplicate", 0.2)
        another = self.make_result(6, "Next chunk", 0.3)
        retrieve.return_value = [first, duplicate, another]

        context = assemble_rag_context(
            user=self.user,
            question="Question",
            request=self.request,
        )

        self.assertEqual(
            [(item.chunk_id, item.content) for item in context.items],
            [(5, "First version"), (6, "Next chunk")],
        )

    @patch("knowledge.services.context.retrieve_scoped_knowledge")
    def test_metadata_is_copied_and_context_dataclasses_are_frozen(self, retrieve):
        original_metadata = {"tags": ["one"]}
        retrieve.return_value = [
            self.make_result(5, "Chunk", 0.1, metadata=original_metadata)
        ]

        context = assemble_rag_context(
            user=self.user,
            question="Question",
            request=self.request,
        )

        self.assertIsNot(context.items[0].metadata, original_metadata)
        context.items[0].metadata["new"] = "value"
        self.assertNotIn("new", original_metadata)
        with self.assertRaises(FrozenInstanceError):
            context.question = "Changed"
        with self.assertRaises(FrozenInstanceError):
            context.items[0].content = "Changed"

    def test_empty_question_is_rejected_without_retrieval(self):
        with patch("knowledge.services.context.retrieve_scoped_knowledge") as retrieve:
            for question in ("", " \n\t "):
                with self.subTest(question=question):
                    with self.assertRaisesRegex(ValueError, "must not be empty"):
                        assemble_rag_context(
                            user=self.user,
                            question=question,
                            request=self.request,
                        )
            retrieve.assert_not_called()

    def test_non_string_question_is_rejected_without_retrieval(self):
        with patch("knowledge.services.context.retrieve_scoped_knowledge") as retrieve:
            for question in (None, 42, ["question"]):
                with self.subTest(question=question):
                    with self.assertRaisesRegex(ValueError, "must be a string"):
                        assemble_rag_context(
                            user=self.user,
                            question=question,
                            request=self.request,
                        )
            retrieve.assert_not_called()

    @patch("knowledge.services.context.retrieve_scoped_knowledge")
    def test_retrieval_error_propagates_unchanged(self, retrieve):
        error = KnowledgeRetrievalError("retrieval failed")
        retrieve.side_effect = error

        with self.assertRaises(KnowledgeRetrievalError) as raised:
            assemble_rag_context(
                user=self.user,
                question="Question",
                request=self.request,
            )

        self.assertIs(raised.exception, error)
