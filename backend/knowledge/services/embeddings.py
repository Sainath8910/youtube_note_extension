"""Lazy, process-local Qwen embedding service."""

from __future__ import annotations

import math
import os
from collections.abc import Callable, Sequence
from functools import lru_cache
from threading import Lock, RLock
from typing import Any


DEFAULT_MODEL_ID = "Qwen/Qwen3-Embedding-0.6B"
DEFAULT_MODEL_REVISION = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"
EMBEDDING_DIMENSION = 1024
DEFAULT_BATCH_SIZE = 8
DEFAULT_QUERY_INSTRUCTION = (
    "Given a technical question, retrieve relevant knowledge passages "
    "that answer it"
)
MAX_INPUT_LENGTH = 512


class EmbeddingServiceError(RuntimeError):
    """Base class for failures raised by the embedding service."""


class EmbeddingModelLoadError(EmbeddingServiceError):
    """The tokenizer or model could not be loaded."""


class EmbeddingTokenizationError(EmbeddingServiceError):
    """Input text could not be tokenized."""


class EmbeddingInferenceError(EmbeddingServiceError):
    """The model could not generate embeddings."""


class EmbeddingOutputError(EmbeddingServiceError):
    """The model returned invalid embeddings."""


class _HuggingFaceBackend:
    def __init__(self, torch: Any, tokenizer: Any, model: Any, device: Any):
        self.torch = torch
        self.tokenizer = tokenizer
        self.model = model
        self.device = device

    @classmethod
    def load(cls, model_id: str, revision: str) -> _HuggingFaceBackend:
        try:
            import torch
            from transformers import AutoModel, AutoTokenizer

            device = select_device(torch)
            tokenizer = AutoTokenizer.from_pretrained(
                model_id,
                revision=revision,
                padding_side="left",
            )
            model = AutoModel.from_pretrained(
                model_id,
                revision=revision,
                dtype=torch.bfloat16,
            ).to(device)
            model.eval()
        except Exception as exc:
            raise EmbeddingModelLoadError(
                f"Could not load embedding model {model_id}."
            ) from exc

        model_dimension = getattr(model.config, "hidden_size", None)
        if model_dimension != EMBEDDING_DIMENSION:
            raise EmbeddingOutputError(
                "Loaded embedding model has dimension "
                f"{model_dimension!r}; expected {EMBEDDING_DIMENSION}."
            )
        return cls(torch, tokenizer, model, device)

    def encode(self, texts: Sequence[str]) -> list[list[float]]:
        try:
            batch = self.tokenizer(
                list(texts),
                padding=True,
                truncation=True,
                max_length=MAX_INPUT_LENGTH,
                return_tensors="pt",
            )
            batch = {
                key: value.to(self.device)
                for key, value in batch.items()
            }
        except Exception as exc:
            raise EmbeddingTokenizationError(
                "Could not tokenize embedding input."
            ) from exc

        try:
            with self.torch.inference_mode():
                output = self.model(**batch)
                attention_mask = batch["attention_mask"]
                if bool((attention_mask[:, -1] == 1).all()):
                    pooled = output.last_hidden_state[:, -1]
                else:
                    final_indices = attention_mask.sum(dim=1) - 1
                    row_indices = self.torch.arange(
                        output.last_hidden_state.shape[0],
                        device=self.device,
                    )
                    pooled = output.last_hidden_state[
                        row_indices,
                        final_indices,
                    ]
        except Exception as exc:
            raise EmbeddingInferenceError(
                "Embedding model inference failed."
            ) from exc

        try:
            return pooled.detach().to(device="cpu", dtype=self.torch.float32).tolist()
        except Exception as exc:
            raise EmbeddingOutputError(
                "Could not convert model output to CPU vectors."
            ) from exc


def select_device(torch_module: Any) -> Any:
    """Use CUDA when available, otherwise use CPU."""
    if torch_module.cuda.is_available():
        return torch_module.device("cuda")
    return torch_module.device("cpu")


def _positive_int(value: str, setting_name: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"{setting_name} must be a positive integer.") from exc
    if parsed < 1:
        raise ValueError(f"{setting_name} must be a positive integer.")
    return parsed


class EmbeddingService:
    """Generate normalized 1024-dimensional document and query vectors.

    Model loading is lazy and cached per service instance. Use
    ``get_embedding_service()`` for the process-wide instance.
    """

    def __init__(
        self,
        *,
        backend_loader: Callable[[str, str], Any] | None = None,
        batch_size: int | None = None,
        model_id: str | None = None,
        revision: str | None = None,
        query_instruction: str | None = None,
    ) -> None:
        self.model_id = model_id or os.getenv(
            "KNOWLEDGE_EMBEDDING_MODEL",
            DEFAULT_MODEL_ID,
        )
        self.revision = revision or os.getenv(
            "KNOWLEDGE_EMBEDDING_REVISION",
            DEFAULT_MODEL_REVISION,
        )
        self.query_instruction = query_instruction or os.getenv(
            "KNOWLEDGE_EMBEDDING_QUERY_INSTRUCTION",
            DEFAULT_QUERY_INSTRUCTION,
        )

        configured_batch_size = (
            str(batch_size)
            if batch_size is not None
            else os.getenv(
                "KNOWLEDGE_EMBEDDING_BATCH_SIZE",
                str(DEFAULT_BATCH_SIZE),
            )
        )
        self.batch_size = _positive_int(
            configured_batch_size,
            "KNOWLEDGE_EMBEDDING_BATCH_SIZE",
        )
        self._backend_loader = backend_loader or _HuggingFaceBackend.load
        self._backend: Any | None = None
        self._load_lock = RLock()
        self._inference_lock = Lock()

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        documents = self._validate_texts(texts, kind="Document")
        if not documents:
            return []

        vectors: list[list[float]] = []
        for start in range(0, len(documents), self.batch_size):
            batch = documents[start : start + self.batch_size]
            vectors.extend(self._embed_batch(batch))
        return vectors

    def embed_query(self, text: str) -> list[float]:
        query = self._validate_texts([text], kind="Query")[0]
        instructed_query = (
            f"Instruct: {self.query_instruction}\nQuery:{query}"
        )
        return self._embed_batch([instructed_query])[0]

    @staticmethod
    def _validate_texts(texts: Sequence[str], *, kind: str) -> list[str]:
        if isinstance(texts, (str, bytes)) or not isinstance(texts, Sequence):
            raise ValueError(f"{kind} input must be a sequence of text values.")

        values = list(texts)
        for index, text in enumerate(values):
            if not isinstance(text, str) or not text.strip():
                raise ValueError(
                    f"{kind} input at index {index} must be a non-empty string."
                )
        return values

    def _get_backend(self) -> Any:
        if self._backend is None:
            with self._load_lock:
                if self._backend is None:
                    try:
                        self._backend = self._backend_loader(
                            self.model_id,
                            self.revision,
                        )
                    except EmbeddingServiceError:
                        raise
                    except Exception as exc:
                        raise EmbeddingModelLoadError(
                            f"Could not load embedding model {self.model_id}."
                        ) from exc
        return self._backend

    def _embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
        backend = self._get_backend()
        try:
            with self._inference_lock:
                vectors = backend.encode(texts)
        except EmbeddingServiceError:
            raise
        except Exception as exc:
            raise EmbeddingInferenceError(
                "Embedding model inference failed."
            ) from exc

        if not isinstance(vectors, Sequence) or len(vectors) != len(texts):
            raise EmbeddingOutputError(
                "Embedding model returned an unexpected number of vectors."
            )

        normalized_vectors = []
        for vector_index, vector in enumerate(vectors):
            if not isinstance(vector, Sequence) or len(vector) != EMBEDDING_DIMENSION:
                actual_dimension = (
                    len(vector) if isinstance(vector, Sequence) else "unknown"
                )
                raise EmbeddingOutputError(
                    f"Embedding {vector_index} has dimension "
                    f"{actual_dimension}; expected {EMBEDDING_DIMENSION}."
                )

            values = []
            for value in vector:
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    raise EmbeddingOutputError(
                        f"Embedding {vector_index} contains a non-numeric value."
                    )
                numeric_value = float(value)
                if not math.isfinite(numeric_value):
                    raise EmbeddingOutputError(
                        f"Embedding {vector_index} contains a non-finite value."
                    )
                values.append(numeric_value)

            norm = math.sqrt(sum(value * value for value in values))
            if norm == 0:
                raise EmbeddingOutputError(
                    f"Embedding {vector_index} has zero magnitude."
                )
            normalized_vectors.append([value / norm for value in values])

        return normalized_vectors


@lru_cache(maxsize=1)
def get_embedding_service() -> EmbeddingService:
    """Return the process-local service without loading the model yet."""
    return EmbeddingService()
