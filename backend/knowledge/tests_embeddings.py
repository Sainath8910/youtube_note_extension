import math
from unittest.mock import Mock

from django.test import SimpleTestCase

from knowledge.services.embeddings import (
    EMBEDDING_DIMENSION,
    DEFAULT_MODEL_ID,
    DEFAULT_MODEL_REVISION,
    EmbeddingInferenceError,
    EmbeddingModelLoadError,
    EmbeddingOutputError,
    EmbeddingService,
    get_embedding_service,
    select_device,
)


def vector_with_first_axis(value=1.0, *, dimension=EMBEDDING_DIMENSION):
    return [value] + [0.0] * (dimension - 1)


class FakeBackend:
    def __init__(self, vectors=None):
        self.calls = []
        self.vectors = vectors

    def encode(self, texts):
        self.calls.append(list(texts))
        if self.vectors is not None:
            return self.vectors(len(texts))
        return [vector_with_first_axis(index + 1) for index in range(len(texts))]


class EmbeddingServiceTests(SimpleTestCase):
    def setUp(self):
        self.backend = FakeBackend()
        self.loader = Mock(return_value=self.backend)
        self.service = EmbeddingService(
            backend_loader=self.loader,
            batch_size=2,
        )

    def test_empty_and_whitespace_queries_are_rejected(self):
        for query in ("", " \n\t"):
            with self.subTest(query=query):
                with self.assertRaisesRegex(ValueError, "non-empty"):
                    self.service.embed_query(query)
        self.loader.assert_not_called()

    def test_empty_document_list_returns_without_loading_model(self):
        self.assertEqual(self.service.embed_documents([]), [])
        self.loader.assert_not_called()

    def test_invalid_or_empty_documents_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "non-empty"):
            self.service.embed_documents(["valid", "  "])
        with self.assertRaisesRegex(ValueError, "sequence"):
            self.service.embed_documents("not a list")
        self.loader.assert_not_called()

    def test_documents_preserve_order_and_return_one_plain_vector_each(self):
        vectors = self.service.embed_documents(["first", "second"])

        self.assertEqual(len(vectors), 2)
        self.assertEqual(len(vectors[0]), EMBEDDING_DIMENSION)
        self.assertEqual(vectors[0][0], 1.0)
        self.assertEqual(vectors[1][0], 1.0)
        self.assertTrue(all(type(value) is float for v in vectors for value in v))
        self.assertEqual(self.backend.calls, [["first", "second"]])

    def test_query_returns_one_vector_and_uses_query_instruction(self):
        vector = self.service.embed_query("How does this work?")

        self.assertEqual(len(vector), EMBEDDING_DIMENSION)
        self.assertTrue(all(type(value) is float for value in vector))
        self.assertEqual(
            self.backend.calls,
            [[
                "Instruct: Given a technical question, retrieve relevant "
                "knowledge passages that answer it\nQuery:"
                "How does this work?"
            ]],
        )

    def test_documents_are_not_given_query_instruction(self):
        self.service.embed_documents(["Document text"])
        self.assertEqual(self.backend.calls, [["Document text"]])

    def test_vectors_are_normalized(self):
        backend = FakeBackend(
            vectors=lambda count: [
                [3.0] + [4.0] + [0.0] * (EMBEDDING_DIMENSION - 2)
                for _ in range(count)
            ]
        )
        service = EmbeddingService(backend_loader=lambda *_: backend)

        vector = service.embed_documents(["text"])[0]

        self.assertAlmostEqual(math.sqrt(sum(value * value for value in vector)), 1.0)
        self.assertEqual(vector[:2], [0.6, 0.8])

    def test_wrong_output_dimension_is_rejected(self):
        backend = FakeBackend(
            vectors=lambda count: [
                vector_with_first_axis(dimension=EMBEDDING_DIMENSION - 1)
                for _ in range(count)
            ]
        )
        service = EmbeddingService(backend_loader=lambda *_: backend)

        with self.assertRaisesRegex(EmbeddingOutputError, "expected 1024"):
            service.embed_documents(["text"])

    def test_wrong_vector_count_is_rejected(self):
        backend = FakeBackend(vectors=lambda count: [])
        service = EmbeddingService(backend_loader=lambda *_: backend)

        with self.assertRaisesRegex(EmbeddingOutputError, "number of vectors"):
            service.embed_documents(["text"])

    def test_model_and_inference_failures_are_clear(self):
        load_failure = EmbeddingService(
            backend_loader=Mock(
                side_effect=EmbeddingModelLoadError("model unavailable")
            )
        )
        with self.assertRaisesRegex(EmbeddingModelLoadError, "model unavailable"):
            load_failure.embed_query("query")

        failing_backend = Mock()
        failing_backend.encode.side_effect = RuntimeError("inference failure")
        inference_failure = EmbeddingService(
            backend_loader=lambda *_: failing_backend
        )
        with self.assertRaisesRegex(EmbeddingInferenceError, "inference failed"):
            inference_failure.embed_query("query")

    def test_backend_is_loaded_once_for_documents_and_queries(self):
        self.service.embed_documents(["document"])
        self.service.embed_query("query")
        self.service.embed_documents(["another document"])

        self.loader.assert_called_once_with(
            DEFAULT_MODEL_ID,
            DEFAULT_MODEL_REVISION,
        )

    def test_documents_are_chunked_by_configured_batch_size(self):
        self.service.embed_documents(["a", "b", "c", "d", "e"])

        self.assertEqual(
            self.backend.calls,
            [["a", "b"], ["c", "d"], ["e"]],
        )

    def test_device_selection_prefers_cuda_and_falls_back_to_cpu(self):
        torch_module = Mock()
        torch_module.cuda.is_available.return_value = True
        torch_module.device.side_effect = lambda name: name
        self.assertEqual(select_device(torch_module), "cuda")

        torch_module.cuda.is_available.return_value = False
        self.assertEqual(select_device(torch_module), "cpu")

    def test_default_service_is_a_lazy_process_singleton(self):
        get_embedding_service.cache_clear()
        try:
            first_service = get_embedding_service()
            second_service = get_embedding_service()
            self.assertIs(first_service, second_service)
            self.assertIsNone(first_service._backend)
        finally:
            get_embedding_service.cache_clear()

    def test_zero_magnitude_vector_is_rejected(self):
        backend = FakeBackend(
            vectors=lambda count: [
                [0.0] * EMBEDDING_DIMENSION for _ in range(count)
            ]
        )
        service = EmbeddingService(backend_loader=lambda *_: backend)

        with self.assertRaisesRegex(EmbeddingOutputError, "zero magnitude"):
            service.embed_documents(["text"])
